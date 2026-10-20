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

test("a one-turn budget disables further investigation and preserves observed usage", async (t) => {
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
      /required finalization|tools were disabled/,
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
      (body) => {
        assert.equal(body.tools, undefined);
        assert.match(JSON.stringify(body.input), /Not executed/);
        return {
          summary:
            "Inspection incomplete: requested commands were not executed because of the tool limit.",
          findings: [],
        };
      },
    ]);
    const limited = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      reviewBudget: { maxToolCalls: 1 },
    });
    assert.match(limited.summary, /Inspection limitation/);
    assert.equal(model.calls, 2);
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
      /No safe finalization budget/,
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
      /No safe finalization budget/,
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
      compactionThresholdTokens: 16000,
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

/** Collects native message text without conflating it with serialized JSON escaping. */
function inputText(body: Record<string, unknown>): string {
  return (body.input as { content?: string | { text?: string }[] }[])
    .map(({ content }) =>
      typeof content === "string"
        ? content
        : (content ?? []).map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

/** Builds a native output-limit response, including usage even when JSON is truncated. */
function truncatedResponse(output: unknown[]) {
  return new Response(
    JSON.stringify({
      id: "limited",
      object: "response",
      created_at: 0,
      model: "fixture",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        output_tokens_details: { reasoning_tokens: 0 },
        input_tokens_details: { cached_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

test("a large immutable prior discussion may exceed the compaction trigger and still be reviewed", async (t) => {
  const f = await diffFixture();
  try {
    const discussion = "long accepted prior discussion ".repeat(4000);
    const model = provider(t, [
      (body) => {
        assert.ok(inputText(body).includes(discussion));
        assert.doesNotMatch(inputText(body), /transcriptFragment/);
        return {
          summary: "Prior finding remains uncertain after limited inspection.",
          findings: [],
          findingChecks: [
            {
              id: "prior",
              status: "uncertain",
              evidence:
                "The prior scenario remains unresolved; no successful verification claimed.",
            },
          ],
        };
      },
    ]);
    const review = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      compactionThresholdTokens: 20000,
      previousFindings: [
        {
          id: "prior",
          reviewId: "rev_1234567890abcdef",
          finding,
          discussion: [
            { id: "discussion", author: "author", body: discussion },
          ],
        },
      ],
    });
    assert.equal(review.findingChecks?.[0].status, "uncertain");
    assert.equal(model.calls, 1);
  } finally {
    await f.close();
  }
});

test("a tools-disabled inline review keeps exact evidence despite a low compaction trigger", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, [
      (body) => {
        assert.match(inputText(body), /new implementation/);
        assert.doesNotMatch(inputText(body), /transcriptFragment/);
        return {
          summary: "No actionable findings in the supplied inline fixture.",
          findings: [],
        };
      },
    ]);
    await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      supportsTools: false,
      compactionThresholdTokens: 1024,
    });
    assert.equal(model.calls, 1);
  } finally {
    await f.close();
  }
});

test("compaction preserves the exact manifest and allows continued paginated diff exploration", async (t) => {
  const f = await diffFixture();
  try {
    const name = "unread manifest path with spaces.txt";
    await f.write(name, "material new context\n");
    const head = await f.commit();
    const { RepositoryTools } = await import("@razbor/harness/repository");
    const prepared = await new RepositoryTools(f.repository).prepareDiff(
      f.base,
      head,
      0,
    );
    const model = provider(t, [
      () => [
        command(
          "large",
          [
            process.execPath,
            "-e",
            "process.stdout.write('reducible-output-marker'.repeat(8000))",
          ],
          400000,
        ),
      ],
      () => ({
        notes:
          "tool-1 returned output. Inspection of unread changes remains unresolved; next read the exact retained manifest paths.",
        evidenceIds: ["tool-1"],
      }),
      (body) => {
        assert.ok(inputText(body).includes(prepared.manifest));
        assert.doesNotMatch(inputText(body), /reducible-output-marker/);
        return [
          {
            id: "diff",
            type: "function_call",
            status: "completed",
            call_id: "diff",
            name: "read_diff",
            arguments: JSON.stringify({ paths: [name] }),
          },
        ];
      },
      (body) => {
        assert.match(JSON.stringify(body.input), /material new context/);
        return {
          summary:
            "Limited inspection: source.ts was not inspected; no actionable finding in supplied material.",
          findings: [],
        };
      },
    ]);
    await reviewRepository(f.repository, f.base, head, {
      ...options,
      initialDiffMaxBytes: 0,
      compactionThresholdTokens: 40000,
      verification: { exec: { maxOutputBytes: 400000 } },
    });
    assert.equal(model.calls, 4);
  } finally {
    await f.close();
  }
});

test("a token-truncated final answer receives exactly one budgeted tool-free correction", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, [
      () =>
        truncatedResponse([
          {
            id: "partial",
            type: "message",
            status: "incomplete",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: '{"summary":"truncated',
                annotations: [],
              },
            ],
          },
        ]),
      (body) => {
        assert.equal(body.tools, undefined);
        assert.match(inputText(body), /correction|failed validation/);
        return {
          summary: "Limited fixture inspection, no actionable findings.",
          findings: [],
        };
      },
    ]);
    const review = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      maxTurns: 2,
    });
    assert.equal(review.findings.length, 0);
    assert.equal(model.calls, 2);
  } finally {
    await f.close();
  }
});

test("incomplete tool turns never execute their partial calls", async (t) => {
  const f = await diffFixture();
  try {
    const marker = path.join(f.repository, "partial-must-not-run");
    const model = provider(t, [
      () =>
        truncatedResponse([
          command("partial", [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
          ]),
        ]),
    ]);
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, options),
      /incomplete|output limit|Model request failed/i,
    );
    assert.equal(model.calls, 1);
    await assert.rejects(access(marker));
  } finally {
    await f.close();
  }
});

test("the last available turn requests explicit limited finalization rather than more investigation", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, [
      () => [command("inspect", ["cat", "source.ts"])],
      (body) => {
        assert.equal(body.tools, undefined);
        assert.match(inputText(body), /finaliz.*now|final response now/i);
        assert.match(inputText(body), /remaining|budget/i);
        return {
          summary:
            "Inspection incomplete: only source.ts was read before the turn budget required finalization.",
          findings: [],
        };
      },
    ]);
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      maxTurns: 2,
    });
    assert.match(result.summary, /incomplete/);
    assert.equal(model.calls, 2);
  } finally {
    await f.close();
  }
});

test("encoded control output stays inside its planned tool-message headroom", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, [
      () => [
        command(
          "controls",
          [
            process.execPath,
            "-e",
            "process.stdout.write(String.fromCharCode(1).repeat(32768))",
          ],
          32768,
        ),
      ],
      (body) => {
        const result = (
          body.input as { type?: string; output?: string }[]
        ).find((item) => item.type === "function_call_output");
        assert.ok(Buffer.byteLength(JSON.stringify(result!.output)) < 35000);
        assert.match(result!.output!, /truncated/);
        return {
          summary:
            "Inspection limited: command output was truncated and no successful test result is claimed.",
          findings: [],
        };
      },
    ]);
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      maxTurns: 2,
      reviewBudget: { maxTokens: 200000 },
    });
    assert.match(result.summary, /limited|limitation/);
    assert.equal(model.calls, 2);
  } finally {
    await f.close();
  }
});

test("compaction admission can fall back to a safe final response without losing history", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, [
      () => [
        {
          id: "analysis",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: '"'.repeat(64000), annotations: [] },
          ],
        },
        command("inspect", ["cat", "source.ts"]),
      ],
      (body) => {
        assert.equal(body.tools, undefined);
        assert.doesNotMatch(inputText(body), /transcriptFragment/);
        assert.match(inputText(body), /Finalize now/);
        assert.match(JSON.stringify(body.input), /new implementation/);
        return {
          summary:
            "Inspection incomplete: summarization could not fit while preserving finalization headroom.",
          findings: [],
        };
      },
    ]);
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      compactionThresholdTokens: 40000,
      reviewBudget: { maxTokens: 580000, maxOutputTokens: 32768 },
    });
    assert.match(result.summary, /incomplete|limitation/);
    assert.equal(model.calls, 2);
  } finally {
    await f.close();
  }
});

/** Returns explicit complete provider telemetry for remaining-budget boundary fixtures. */
function measuredResponse(output: unknown[], inputTokens: number) {
  return new Response(
    JSON.stringify({
      id: "measured",
      object: "response",
      created_at: 0,
      model: "fixture",
      status: "completed",
      output,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 10,
        total_tokens: inputTokens + 10,
        output_tokens_details: { reasoning_tokens: 0 },
        input_tokens_details: { cached_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

for (const boundary of ["tokens", "cost"] as const) {
  test(`unfinished investigation finalizes before the ${boundary} ceiling without executing an unaffordable tool batch`, async (t) => {
    const f = await diffFixture();
    try {
      const events: ReviewProgress[] = [];
      const model = provider(t, [
        () => measuredResponse([command("first", ["cat", "source.ts"])], 5000),
        () =>
          measuredResponse([command("second", ["cat", "related.ts"])], 20000),
        (body) => {
          assert.equal(body.tools, undefined);
          assert.match(inputText(body), /Finalize now/);
          assert.match(inputText(body), /remaining review budget/i);
          assert.match(JSON.stringify(body.input), /Not executed/);
          assert.doesNotMatch(JSON.stringify(body.input), /related unchanged/);
          return {
            summary: "Caller inspection remains incomplete.",
            findings: [],
          };
        },
      ]);
      const result = await reviewRepository(f.repository, f.base, f.head, {
        ...options,
        initialDiffMaxBytes: 0,
        maxTurns: 8,
        reviewBudget: {
          maxOutputTokens: 100,
          maxTokens: boundary === "tokens" ? 60000 : 1000000,
          ...(boundary === "cost"
            ? {
                maxCostUsd: 0.06,
                pricing: {
                  model: "fixture",
                  inputUsdPerMillion: 1,
                  cachedInputUsdPerMillion: 1,
                  outputUsdPerMillion: 1,
                  cacheWriteUsdPerMillion: 1,
                },
              }
            : {}),
        },
        onProgress: (event) => events.push(event),
      });
      assert.equal(model.calls, 3);
      assert.equal(events.at(-1)!.toolCalls, 1);
      assert.match(result.summary, /Inspection limitation/);
      assert.ok(events.at(-1)!.budgetTokens! <= 60000);
      if (boundary === "cost")
        assert.ok(events.at(-1)!.estimatedCostUsd! <= 0.06);
    } finally {
      await f.close();
    }
  });
}

test("every compaction dispatch fits a separate configured model window before exploration resumes", async (t) => {
  const f = await diffFixture();
  try {
    let summaries = 0;
    const model = provider(t, [
      () => [
        command(
          "large",
          [
            process.execPath,
            "-e",
            "process.stdout.write('context observation '.repeat(7000))",
          ],
          150000,
        ),
      ],
      ...Array.from({ length: 12 }, () => (body: Record<string, unknown>) => {
        const text = inputText(body);
        assert.ok(
          Math.ceil(Buffer.byteLength(JSON.stringify(body.input)) / 3) + 1000 <=
            20000,
        );
        if (text.includes('"transcriptFragment"')) {
          summaries++;
          assert.equal(body.tools, undefined);
          return {
            notes:
              "tool-1 returned bounded source text; relevant caller investigation remains unresolved and must continue.",
            evidenceIds: ["tool-1"],
          };
        }
        assert.match(text, /Exact changed-file manifest/);
        assert.match(text, /source\.ts/);
        return {
          summary:
            "Limited source inspection; relevant callers remain uninspected.",
          findings: [],
        };
      }),
    ]);
    await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      initialDiffMaxBytes: 0,
      contextWindowTokens: 20000,
      compactionThresholdTokens: 1024,
      maxTurns: 14,
      reviewBudget: { maxTokens: 3000000, maxOutputTokens: 1000 },
      verification: { exec: { maxOutputBytes: 150000 } },
    });
    assert.ok(summaries >= 2);
    assert.equal(model.calls, summaries + 2);
  } finally {
    await f.close();
  }
});

test("an actual configured window rejects oversized immutable context before any paid dispatch", async (t) => {
  const f = await diffFixture();
  try {
    const model = provider(t, []);
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        ...options,
        supportsTools: false,
        contextWindowTokens: 8192,
        compactionThresholdTokens: 1024,
        reviewBudget: { maxOutputTokens: 1000 },
        previousFindings: [
          {
            id: "prior",
            reviewId: "rev_1234567890abcdef",
            finding,
            discussion: [
              {
                id: "discussion",
                author: "author",
                body: "unresolved prior discussion ".repeat(4000),
              },
            ],
          },
        ],
      }),
      /configured model context window/,
    );
    assert.equal(model.calls, 0);
  } finally {
    await f.close();
  }
});

test("partial multi-fragment compaction preserves original finalization headroom when usage is missing", async (t) => {
  const f = await diffFixture();
  try {
    let compactedFragments = 0;
    const events: ReviewProgress[] = [];
    const model = provider(t, [
      () => [
        command(
          "large-control-observation",
          [
            process.execPath,
            "-e",
            "process.stdout.write('original-observation-marker'+String.fromCharCode(1).repeat(1000000))",
          ],
          1000000,
        ),
      ],
      ...Array.from({ length: 14 }, () => (body: Record<string, unknown>) => {
        if (inputText(body).includes("transcriptFragment")) {
          compactedFragments++;
          return new Response(
            JSON.stringify({
              id: "unmeasured-compaction",
              object: "response",
              created_at: 0,
              status: "completed",
              model: "fixture",
              output: [
                {
                  id: "note",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        notes:
                          "tool-1 returned bounded observations. Investigation remains unresolved; no tests were verified. Continue from retained original evidence if summarization cannot finish.",
                        evidenceIds: ["tool-1"],
                      }),
                      annotations: [],
                    },
                  ],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        assert.equal(body.tools, undefined);
        assert.match(inputText(body), /Finalize now/);
        assert.match(JSON.stringify(body.input), /original-observation-marker/);
        return {
          summary:
            "Inspection incomplete: original observations remain available after partial summarization; no successful check is claimed.",
          findings: [],
        };
      }),
    ]);
    const result = await reviewRepository(f.repository, f.base, f.head, {
      ...options,
      maxTurns: 16,
      compactionThresholdTokens: 40000,
      reviewBudget: { maxTokens: 2100000 },
      verification: { exec: { maxOutputBytes: 1000000 } },
      /** Retains conservative charges without copying the large command output. */
      onProgress: (event) => events.push(event),
    });
    assert.ok(compactedFragments > 0);
    assert.equal(model.calls, compactedFragments + 2);
    assert.ok(model.calls <= 16);
    assert.ok(events.at(-1)!.budgetTokens! <= 2100000);
    assert.equal(events.at(-1)!.tokenUsageComplete, false);
    assert.match(
      result.summary,
      /original investigation history remains available/,
    );
  } finally {
    await f.close();
  }
});
