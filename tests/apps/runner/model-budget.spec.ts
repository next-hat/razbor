import assert from "node:assert/strict";
import { test } from "node:test";

import { createReviewModel, ModelRequestError } from "@razbor/harness/model";
import { runnerConfigSchema } from "@razbor/runner/config";
import { ModelRelay } from "@razbor/runner/relay";

/** Creates an in-memory relay with no listening socket or real model credentials. */
function fixture(provider: "openai" | "anthropic" = "openai") {
  const configured = runnerConfigSchema.parse({
    model: { provider, max_retries: 3 },
  });
  const relay = new ModelRelay({
    ...configured,
    endpoint: "http://fixture.invalid/v1/model",
    apiKey: "private-provider-key",
    model: { ...configured.model, model: "trusted-model" },
  });
  const controller = new AbortController();
  const access = relay.issue(controller.signal);
  /** Sends directly through the authorized relay handler without a network server. */
  const request = (extra: Record<string, unknown> = {}) =>
    relay.handleRequest(
      new Request(
        `http://relay.invalid/v1/${provider === "anthropic" ? "messages" : "responses"}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${access.token}`,
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
