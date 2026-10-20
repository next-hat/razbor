import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";

import pino, { type Logger } from "pino";

import type {
  ReviewFinding,
  ReviewProgress,
  PreviousFinding,
} from "@razbor/contracts";
import { reviewRepository, type ReviewConfig } from "@razbor/harness";

import { diffFixture } from "@tests/packages/harness/diff-fixture.js";

const options: ReviewConfig = {
  baseUrl: "http://fixture.invalid/v1",
  apiKey: "fixture",
  model: "fixture",
  reasoningEffort: "low",
  reviewId: "fixture",
};

const finding: ReviewFinding = {
  severity: "high",
  path: "source.ts",
  lineStart: 1,
  lineEnd: 1,
  title: "Changed implementation loses prior behavior",
  body: "The changed source returns the new behavior unconditionally.",
  failureScenario:
    "An existing caller expecting the old behavior receives the new result.",
  suggestion: "Preserve the existing caller contract in source.ts.",
  replacement: null,
};

type FixtureStep = (
  body: Record<string, unknown>,
  init: RequestInit,
) => unknown | Promise<unknown>;

/** Installs deterministic provider replies while keeping real harness command execution. */
function provider(t: TestContext, steps: FixtureStep[]) {
  let calls = 0;
  const globals = globalThis as typeof globalThis & { razborLogger?: Logger };
  const previous = globals.razborLogger;
  globals.razborLogger = pino({ enabled: false });
  t.after(() => {
    globals.razborLogger = previous;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const step = steps[calls++];
      assert.ok(step, "Unexpected extra model dispatch");
      const value = await step(JSON.parse(String(init.body)), init);
      if (value instanceof Response) return value;
      return new Response(
        JSON.stringify({
          id: "fixture",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "fixture",
          output: Array.isArray(value)
            ? value
            : [
                {
                  id: "message",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text:
                        typeof value === "string"
                          ? value
                          : JSON.stringify(value),
                      annotations: [],
                    },
                  ],
                },
              ],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            output_tokens_details: { reasoning_tokens: 0 },
            input_tokens_details: { cached_tokens: 50 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  return {
    /** Reports actual intercepted model dispatches, including compaction. */
    get calls() {
      return calls;
    },
  };
}

/** Builds a model command request without invoking any alternate execution tool. */
function command(id: string, argv: string[], maxOutputBytes?: number) {
  return {
    id,
    type: "function_call",
    status: "completed",
    call_id: id,
    name: "exec",
    arguments: JSON.stringify({
      argv,
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    }),
  };
}

test("agent explores callers and pinned source exclusively through exec before returning a finding", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, [
      () => [
        command("diff", ["git", "diff", f.base, f.head, "--", "source.ts"]),
        command("caller", ["cat", "related.ts"]),
        command("source", ["git", "show", `${f.head}:source.ts`]),
      ],
      (body) => {
        const transcript = JSON.stringify(body.input);
        assert.match(transcript, /new implementation/);
        assert.match(transcript, /related unchanged/);
        assert.doesNotMatch(
          transcript,
          /"name":"read_file"|"name":"read_diff"|checkpoint JSON|Recorded evidence IDs/,
        );
        return {
          summary: "Source-backed fixture finding; no test execution claimed.",
          findings: [finding],
        };
      },
    ]);
    const events: ReviewProgress[] = [];
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      initialDiffMaxBytes: 0,
      /** Capture final attempt counters without retaining source in progress logs. */
      onProgress: (event) => events.push(event),
    });
    assert.equal(result.findings.length, 1);
    assert.equal(model.calls, 2);
    assert.equal(events.at(-1)!.toolCalls, 3);
    assert.equal(events.at(-1)!.inputTokens, 200);
    assert.match(result.summary, /coverage limitation/);
  } finally {
    await f.close();
  }
});

test("final source locations reject unchanged, out-of-range and unsafe paths even after working-tree mutation", async (t) => {
  const f = await diffFixture();
  try {
    let candidate = finding;
    provider(
      t,
      Array.from({ length: 5 }, () => async () => {
        await f.write("source.ts", "working tree only\n".repeat(200));
        return { summary: "Fixture", findings: [candidate] };
      }),
    );
    for (const location of [
      { path: "source.ts", lineStart: 50, lineEnd: 50 },
      { path: "source.ts", lineStart: 2, lineEnd: 2 },
      { path: "related.ts", lineStart: 1, lineEnd: 1 },
      { path: "../outside", lineStart: 1, lineEnd: 1 },
    ]) {
      candidate = { ...finding, ...location };
      await assert.rejects(
        reviewRepository(f.repository, f.base, f.head, {
          ...options,
          maxTurns: 1,
        }),
      );
    }
    candidate = finding;
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      maxTurns: 1,
    });
    assert.equal(result.findings[0].lineEnd, 1);
  } finally {
    await f.close();
  }
});

test("every prior finding must be reassessed and invalid output gets only one budgeted correction", async (t) => {
  const f = await diffFixture();
  const previous: PreviousFinding[] = [
    {
      id: "prior",
      reviewId: "rev_1234567890abcdef",
      originalHead: f.base,
      finding,
      discussion: [
        {
          id: "reply",
          author: "author",
          body: "This is fixed in the new implementation.",
        },
      ],
    },
  ];
  try {
    const model = provider(t, [
      () => ({ summary: "Missing required prior check", findings: [] }),
      (body) => {
        assert.match(JSON.stringify(body.input), /prior|This is fixed/);
        return {
          summary: "Prior finding resolved by inspected source.ts:1.",
          findings: [],
          findingChecks: [
            {
              id: "prior",
              status: "resolved",
              evidence:
                "source.ts:1 at recorded head replaces the original behavior.",
            },
          ],
        };
      },
    ]);
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      previousFindings: previous,
    });
    assert.equal(result.findingChecks?.[0].status, "resolved");
    assert.equal(model.calls, 2);
  } finally {
    await f.close();
  }
});

test("model and tool budgets stop further work and preserve observed usage", async (t) => {
  const f = await diffFixture();
  try {
    const events: ReviewProgress[] = [];
    const model = provider(t, [() => [command("read", ["cat", "source.ts"])]]);
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        ...options,
        maxTurns: 1,
        /** Retain failed-attempt usage for assertions. */
        onProgress: (event) => events.push(event),
      }),
      /budget exhausted.*model turns/,
    );
    assert.equal(model.calls, 1);
    assert.equal(events.at(-1)!.inputTokens, 100);
    assert.equal(events.at(-1)!.outputTokens, 10);
    assert.equal(events.at(-1)!.modelTurns, 1);
  } finally {
    await f.close();
  }
});

test("an oversized tool batch is rejected before its first command side effect", async (t) => {
  const f = await diffFixture();
  try {
    const marker = path.join(f.repository, "must-not-exist");
    const model = provider(t, [
      () => [
        command("one", [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ]),
        command("two", ["cat", "source.ts"]),
      ],
    ]);
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        ...options,
        reviewBudget: { maxToolCalls: 1 },
      }),
      /budget exhausted.*tool calls/,
    );
    assert.equal(model.calls, 1);
    await assert.rejects(access(marker));
  } finally {
    await f.close();
  }
});

test("token and configured monetary reservations reject before model dispatch", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, []);
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        ...options,
        reviewBudget: { maxTokens: 100 },
      }),
      /budget exhausted.*tokens/,
    );
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        ...options,
        reviewBudget: {
          maxCostUsd: 0.000001,
          pricing: {
            model: "fixture",
            inputUsdPerMillion: 1,
            cachedInputUsdPerMillion: 1,
            cacheWriteUsdPerMillion: 1,
            outputUsdPerMillion: 1,
          },
        },
      }),
      /budget exhausted.*monetary/,
    );
    assert.equal(model.calls, 0);
  } finally {
    await f.close();
  }
});

test("provider failure is never retried and failed attempts retain conservative charges", async (t) => {
  const f = await diffFixture();
  try {
    const events: ReviewProgress[] = [];
    const model = provider(t, [
      () => new Response("unavailable", { status: 503 }),
    ]);
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        ...options,
        /** Retain safe failure metrics without copying the provider response body. */
        onProgress: (event) => events.push(event),
      }),
      /Model request failed/,
    );
    assert.equal(model.calls, 1);
    assert.equal(events.at(-1)!.tokenUsageComplete, false);
    assert.ok(events.at(-1)!.budgetTokens! > 0);
    assert.doesNotMatch(JSON.stringify(events), /unavailable/);
  } finally {
    await f.close();
  }
});

test("cancellation aborts an in-flight model request and prevents continuation", async (t) => {
  const f = await diffFixture();
  try {
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model = provider(t, [
      (_body, init) =>
        new Promise((_resolve, reject) => {
          started();
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    ]);
    const review = reviewRepository(f.repository, f.base, f.head, {
      ...options,
      signal: abort.signal,
    });
    await ready;
    abort.abort(new Error("cancelled by fixture"));
    await assert.rejects(review, /cancelled/);
    assert.equal(model.calls, 1);
  } finally {
    await f.close();
  }
});

test("automatic compaction shares budget and keeps revision and prior obligations without replaying tool output", async (t) => {
  const f = await diffFixture();
  try {
    const previous: PreviousFinding[] = [
      {
        id: "prior",
        reviewId: "rev_1234567890abcdef",
        originalHead: f.base,
        finding,
      },
    ];
    const model = provider(t, [
      () => [
        command(
          "large",
          [
            process.execPath,
            "-e",
            "process.stdout.write('distinct-output-marker'.repeat(3000))",
          ],
          100000,
        ),
      ],
      (body) => {
        assert.match(JSON.stringify(body.input), /transcriptFragment/);
        assert.equal(body.tools, undefined);
        return {
          notes:
            "Inspected command output tool-1. Source claim remains unresolved; no tests ran. Next inspect source.ts. Prior obligation remains separately retained.",
          evidenceIds: ["tool-1"],
        };
      },
      (body) => {
        const transcript = JSON.stringify(body.input);
        assert.match(transcript, new RegExp(f.head));
        assert.match(transcript, /prior|remains unresolved|no tests ran/);
        assert.doesNotMatch(transcript, /distinct-output-marker/);
        assert.equal((body.input as { role?: string }[])[0].role, "system");
        return {
          summary:
            "Inspection limitation: prior finding remains uncertain; command output alone did not verify it.",
          findings: [],
          findingChecks: [
            {
              id: "prior",
              status: "uncertain",
              evidence:
                "Source verification remains unresolved after command exploration.",
            },
          ],
        };
      },
    ]);
    const events: ReviewProgress[] = [];
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      previousFindings: previous,
      compactionThresholdTokens: 40000,
      verification: { exec: { maxOutputBytes: 100000 } },
      /** Count compaction requests as part of the same review attempt. */
      onProgress: (event) => events.push(event),
    });
    assert.equal(model.calls, 3);
    assert.equal(events.at(-1)!.modelTurns, 3);
    assert.equal(events.at(-1)!.inputTokens, 300);
    assert.equal(result.findingChecks?.[0].status, "uncertain");
  } finally {
    await f.close();
  }
});

test("valid command-discovered findings in source blobs above one megabyte remain publishable", async (t) => {
  const f = await diffFixture();
  try {
    const tail = "unchanged context\n".repeat(70000);
    await f.write("large.ts", "old first line\n" + tail);
    const base = await f.commit();
    await f.write("large.ts", "new first line\n" + tail);
    const head = await f.commit();
    provider(t, [
      () => ({
        summary: "Source-backed fixture",
        findings: [{ ...finding, path: "large.ts" }],
      }),
    ]);
    const result = await reviewRepository(f.repository, base, head, {
      ...options,
      maxTurns: 1,
    });
    assert.equal(result.findings[0].path, "large.ts");
  } finally {
    await f.close();
  }
});
