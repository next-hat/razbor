import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import timers from "node:timers/promises";

import { createReviewModel, ModelRequestError } from "@razbor/harness/model";
import { runnerConfigSchema } from "@razbor/runner/config";
import { ModelRelay } from "@razbor/runner/relay";

/** Creates an in-memory relay with no listening socket or real model credentials. */
function fixture(
  provider: "openai" | "anthropic" = "openai",
  model: Partial<ReturnType<typeof runnerConfigSchema.parse>["model"]> = {},
  diagnostic?: (message: string) => void,
) {
  const configured = runnerConfigSchema.parse({
    model: { provider, max_retries: 3, ...model },
  });
  const relay = new ModelRelay({
    ...configured,
    endpoint: "http://fixture.invalid/v1/model",
    apiKey: "private-provider-key",
    model: { ...configured.model, model: "trusted-model" },
  });
  const controller = new AbortController();
  const access = relay.issue(controller.signal, undefined, diagnostic);
  /** Sends directly through the authorized relay handler without a network server. */
  const request = (extra: Record<string, unknown> = {}, token = access.token) =>
    relay.handleRequest(
      new Request(
        `http://relay.invalid/v1/${provider === "anthropic" ? "messages" : "responses"}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...(provider === "anthropic"
              ? { messages: [{ role: "user", content: "review" }] }
              : { input: [{ role: "user", content: "review" }] }),
            ...extra,
          }),
        },
      ),
    );
  return { relay, controller, access, request };
}

/** Advances only relay backoff in a virtual clock, or blocks it until cancellation. */
function retryClock(t: TestContext, block = false) {
  let now = Date.now();
  let ready!: (milliseconds: number) => void;
  const waiting = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const waits: number[] = [];
  const mocked = t.mock.method(timers, "setTimeout", ((
    milliseconds = 1,
    value?: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    waits.push(milliseconds);
    ready(milliseconds);
    options?.signal?.throwIfAborted();
    if (!block) {
      now += milliseconds;
      return Promise.resolve(value);
    }
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof timers.setTimeout);
  t.mock.method(Date, "now", () => now);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return { waits, waiting };
}

/** Represents a positively classified pre-generation throttle, never a billed result. */
function throttle(provider: "openai" | "anthropic", headers = {}) {
  return new Response(
    JSON.stringify({
      error:
        provider === "openai"
          ? { type: "requests", code: "rate_limit_exceeded" }
          : { type: "rate_limit_error" },
    }),
    { status: 429, headers: { "retry-after": "2", ...headers } },
  );
}

test("relay respects the reserved response cap and pins the model for both providers", async (t) => {
  for (const provider of ["openai", "anthropic"] as const) {
    const f = fixture(provider);
    let body: Record<string, unknown> | undefined;
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    );
    try {
      const response = await f.request({
        model: "untrusted",
        max_output_tokens: 31,
        max_tokens: 31,
      });
      assert.equal(response.status, 200);
      assert.equal(body?.model, "trusted-model");
      assert.equal(
        provider === "anthropic" ? body?.max_tokens : body?.max_output_tokens,
        31,
      );
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
});

test("relay never repeats a potentially billed failed request, including rate rejection", async (t) => {
  for (const status of [429, 500, 502]) {
    const f = fixture();
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response("provider-secret-body", {
          status,
          headers: { "x-should-retry": "true", "retry-after-ms": "1" },
        }),
    );
    try {
      const response = await f.request();
      assert.equal(response.status, status === 429 ? 429 : 502);
      assert.equal(response.headers.get("x-should-retry"), "false");
      assert.doesNotMatch(
        await response.text(),
        /provider-secret-body|private-provider-key/,
      );
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
});

test("relay retries explicit nonbillable throttles with Retry-After and one fixed request deadline", async (t) => {
  const clock = retryClock(t);
  for (const provider of ["openai", "anthropic"] as const) {
    const f = fixture(provider, { max_retries: 2 });
    const signals: AbortSignal[] = [];
    const bodies: string[] = [];
    const dispatched: number[] = [];
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init!.signal!);
        bodies.push(String(init!.body));
        dispatched.push(Date.now());
        return signals.length === 1
          ? throttle(provider, { "retry-after": "120" })
          : new Response("{}");
      },
    );
    try {
      const response = await f.request();
      assert.equal(response.status, 200);
      assert.equal(fetch.mock.callCount(), 2);
      assert.equal(signals[0], signals[1]);
      assert.equal(bodies[0], bodies[1]);
      assert.ok(dispatched[1] - dispatched[0] >= 120000);
      assert.equal(response.headers.get("x-razbor-usage-incomplete"), null);
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
  assert.deepEqual(clock.waits, [120000, 120000]);
});

test("recognized OpenAI rate rejections without delay headers use bounded exponential backoff", async (t) => {
  const clock = retryClock(t);
  for (const code of ["rate_limit_exceeded", "slow_down"]) {
    const f = fixture("openai", { max_retries: 2 });
    let calls = 0;
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return calls < 3
        ? new Response(
            JSON.stringify({ error: { code, type: "rate_limit_error" } }),
            { status: 429 },
          )
        : new Response("{}");
    });
    try {
      assert.equal((await f.request()).status, 200);
      assert.equal(calls, 3);
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
  assert.deepEqual(clock.waits, [1000, 2000, 1000, 2000]);
});

test("relay limits transient retries, accepts zero retries, and sanitizes exhausted failures", async (t) => {
  const clock = retryClock(t);
  for (const retries of [0, 2]) {
    const diagnostics: string[] = [];
    const f = fixture("openai", { max_retries: retries }, (message) =>
      diagnostics.push(message),
    );
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      throttle("openai", { "retry-after-ms": "25" }),
    );
    try {
      const response = await f.request();
      assert.equal(response.status, 429);
      assert.equal(fetch.mock.callCount(), retries + 1);
      assert.equal(response.headers.get("x-should-retry"), "false");
      assert.doesNotMatch(
        await response.text(),
        /rate_limit_exceeded|private-provider-key/,
      );
      assert.doesNotMatch(
        JSON.stringify(diagnostics),
        /private-provider-key|"error"/,
      );
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
  assert.deepEqual(clock.waits, [25, 25]);
});

test("permanent, unknown, usage-bearing and explicitly nonretryable429 responses never repeat", async (t) => {
  for (const entry of [
    { error: { type: "insufficient_quota", code: "insufficient_quota" } },
    { error: { type: "rate_limit_error", code: "credit_balance_exhausted" } },
    { error: { type: "rate_limit_error", code: "subscription_disabled" } },
    { error: { code: "429", message: "Your subscription has been blocked" } },
    {
      error: {
        code: "RateLimitReached",
        message: "Your subscription has been blocked",
      },
    },
    { error: { type: "unknown_provider_error" } },
    { error: { code: "rate_limit_exceeded", type: "insufficient_quota" } },
    {
      error: { code: "rate_limit_exceeded", type: "requests" },
      usage: { input_tokens: 1 },
    },
  ]) {
    const f = fixture();
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify(entry), {
          status: 429,
          headers: { "x-should-retry": "true", "retry-after-ms": "1" },
        }),
    );
    try {
      const response = await f.request();
      assert.equal(response.status, 429);
      assert.equal(fetch.mock.callCount(), 1);
      assert.doesNotMatch(
        await response.text(),
        /subscription|insufficient|input_tokens/,
      );
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
  const f = fixture();
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    throttle("openai", { "x-should-retry": "false" }),
  );
  try {
    assert.equal((await f.request()).status, 429);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    fetch.mock.restore();
    f.access.revoke();
    await f.relay.close();
  }
});

test("ambiguous Claude spend-cap and uncoded OpenAI rate errors are not transient throttles", async (t) => {
  const clock = retryClock(t);
  for (const provider of ["anthropic", "openai"] as const) {
    const f = fixture(provider);
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "rate_limit_error",
              message: "Monthly spend cap reached",
            },
          }),
          { status: 429 },
        ),
    );
    try {
      assert.equal((await f.request()).status, 429);
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
  assert.deepEqual(clock.waits, []);
});

test("cancellation interrupts Retry-After before another provider dispatch", async (t) => {
  const clock = retryClock(t, true);
  const f = fixture();
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    throttle("openai"),
  );
  try {
    const request = f.request();
    const settled = request.then(
      () => "settled",
      () => "settled",
    );
    const state = await Promise.race([
      clock.waiting.then(() => "waiting"),
      settled,
    ]);
    assert.equal(state, "waiting");
    f.controller.abort();
    await assert.rejects(request, /Aborted/);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    fetch.mock.restore();
    f.access.revoke();
    await f.relay.close();
  }
});

test("the fixed request deadline cancels throttle backoff without another dispatch", async (t) => {
  const clock = retryClock(t, true);
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const f = fixture("openai", { timeout_ms: 100 });
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    throttle("openai"),
  );
  try {
    const request = f.request();
    const settled = request.then(
      () => "settled",
      () => "settled",
    );
    assert.equal(
      await Promise.race([clock.waiting.then(() => "waiting"), settled]),
      "waiting",
    );
    deadlines
      .at(-1)!
      .abort(new DOMException("Deadline reached", "TimeoutError"));
    assert.equal((await request).status, 502);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    fetch.mock.restore();
    f.access.revoke();
    await f.relay.close();
  }
});

test("oversized429 bodies retain provider pacing and quota headers for shared credentials without retry", async (t) => {
  const clock = retryClock(t);
  for (const retryAfter of [45, 120]) {
    const f = fixture("openai", { max_response_bytes: 1024 });
    let other: ReturnType<ModelRelay["issue"]> | undefined;
    let calls = 0;
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      ++calls === 1
        ? new Response(
            JSON.stringify({
              error: {
                code: "rate_limit_exceeded",
                type: "requests",
                message: "private-provider-key".repeat(100),
              },
            }),
            {
              status: 429,
              headers: {
                "retry-after": String(retryAfter),
                "x-ratelimit-limit-requests": "100",
                "x-ratelimit-remaining-requests": "0",
                "x-ratelimit-reset-requests": "75",
              },
            },
          )
        : new Response("{}"),
    );
    try {
      const response = await f.request();
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("x-should-retry"), "false");
      assert.doesNotMatch(
        await response.text(),
        /private-provider-key|rate_limit_exceeded/,
      );
      assert.equal(fetch.mock.callCount(), 1);
      const rejectedAt = Date.now();
      other = f.relay.issue(new AbortController().signal);
      assert.equal((await f.request({}, other.token)).status, 200);
      assert.equal(Date.now() - rejectedAt, Math.max(75000, retryAfter * 1000));
      assert.equal(fetch.mock.callCount(), 2);
    } finally {
      fetch.mock.restore();
      other?.revoke();
      f.access.revoke();
      await f.relay.close();
    }
  }
  assert.deepEqual(clock.waits, [75000, 120000]);
});

test("attempt cancellation aborts an in-flight provider call without retry", async (t) => {
  const f = fixture();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  );
  try {
    const request = f.request();
    await dispatched;
    f.controller.abort();
    await assert.rejects(request, /Aborted/);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    fetch.mock.restore();
    f.access.revoke();
    await f.relay.close();
  }
});

test("relay does not retry transport errors or unrelated abort failures", async (t) => {
  for (const error of [
    new Error("private-provider-key transport failure"),
    new DOMException("private-provider-key abort failure", "AbortError"),
  ]) {
    const diagnostics: string[] = [];
    const f = fixture("openai", {}, (message) => diagnostics.push(message));
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw error;
    });
    try {
      await assert.rejects(f.request(), (failure) => failure === error);
      assert.equal(fetch.mock.callCount(), 1);
      assert.doesNotMatch(
        JSON.stringify(diagnostics),
        /private-provider-key|transport failure|abort failure/,
      );
    } finally {
      fetch.mock.restore();
      f.access.revoke();
      await f.relay.close();
    }
  }
});

test("model adapter makes one dispatch on HTTP or transport failure and hides provider details", async (t) => {
  for (const transport of [false, true]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      if (transport) throw new Error("private-provider-key transport payload");
      return new Response(
        JSON.stringify({
          error: { message: "private-provider-key provider payload" },
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json",
            "x-should-retry": "true",
          },
        },
      );
    });
    try {
      const model = createReviewModel({
        baseUrl: "http://fixture.invalid/v1",
        apiKey: "private-provider-key",
        model: "trusted-model",
        reasoningEffort: "low",
        maxOutputTokens: 31,
      });
      await assert.rejects(
        model.generate(
          [{ role: "user", content: "Review the pinned change" }],
          [],
          "none",
        ),
        (error: unknown) => {
          assert.ok(error instanceof ModelRequestError);
          assert.doesNotMatch(
            error.message,
            /private-provider-key|provider payload|transport payload/,
          );
          return true;
        },
      );
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fetch.mock.restore();
    }
  }
});

test("native Claude response preserves uncached, cache-read and cache-write billing through the SDK", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "trusted-model",
          content: [
            { type: "text", text: '{"summary":"No findings","findings":[]}' },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 40,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  try {
    const model = createReviewModel({
      provider: "anthropic",
      baseUrl: "http://fixture.invalid/v1",
      apiKey: "fixture",
      model: "trusted-model",
      reasoningEffort: "low",
      maxOutputTokens: 100,
    });
    const result = await model.generate(
      [{ role: "user", content: "Review the pinned change" }],
      [],
      "none",
    );
    assert.equal(result.complete, true);
    assert.deepEqual(result.usage, {
      inputTokens: 100,
      outputTokens: 20,
      uncachedInputTokens: 40,
      cachedInputTokens: 50,
      cacheWriteTokens: 10,
    });
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    fetch.mock.restore();
  }
});

test("fallback throttle backoff caps at30 seconds including pacing a later shared-credential request", async (t) => {
  const clock = retryClock(t);
  const f = fixture("openai", { max_retries: 10 });
  let other: ReturnType<ModelRelay["issue"]> | undefined;
  let calls = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    ++calls <= 11
      ? new Response(
          JSON.stringify({
            error: { code: "rate_limit_exceeded", type: "requests" },
          }),
          { status: 429 },
        )
      : new Response("{}"),
  );
  try {
    assert.equal((await f.request()).status, 429);
    assert.equal(fetch.mock.callCount(), 11);
    const rejectedAt = Date.now();
    other = f.relay.issue(new AbortController().signal);
    assert.equal((await f.request({}, other.token)).status, 200);
    assert.equal(Date.now() - rejectedAt, 30000);
    assert.deepEqual(
      clock.waits,
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000],
    );
    assert.equal(fetch.mock.callCount(), 12);
  } finally {
    fetch.mock.restore();
    other?.revoke();
    f.access.revoke();
    await f.relay.close();
  }
});
