import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelMessage } from "ai";

import {
  compactReviewContext,
  estimateContextTokens,
  MAX_COMPACTION_INPUT_BYTES,
  MAX_RETAINED_CONTEXT_BYTES,
} from "@razbor/harness/context";

type Generate = Parameters<typeof compactReviewContext>[0]["generate"];

type Turn = Awaited<ReturnType<Generate>>;

/** Creates a complete compaction response without invoking a provider. */
function response(
  notes = "The command failed; the caller still needs inspection.",
  evidenceIds: string[] = [],
): Turn {
  return {
    text: JSON.stringify({ notes, evidenceIds }),
    calls: [],
    messages: [],
    complete: true,
    tokenLimitReached: false,
    usage: { inputTokens: 20, outputTokens: 10 },
  };
}

/** Builds one ordinary history message with a failed, explicitly unresolved check. */
function history(): ModelMessage[] {
  return [
    {
      role: "user",
      content:
        "tool-1: git test exited 1; caller inspection is unresolved; full-output-marker",
    },
  ];
}

test("context estimation conservatively counts serialized UTF-8 and escaping", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: '💡 Unicode "quoted" output\n' },
  ];
  assert.equal(
    estimateContextTokens(messages),
    Buffer.byteLength(JSON.stringify(messages), "utf8"),
  );
  assert.ok(estimateContextTokens(messages) > messages[0].content.length);
  assert.equal(estimateContextTokens([]), 2);
});

test("compaction preserves immutable objective, revisions and previous-finding obligations intact", async () => {
  const retained: ModelMessage[] = [
    { role: "system", content: "Stable review objective and quality rules." },
    {
      role: "user",
      content:
        "base=abc123; head=def456. Reassess prior finding F-1 about a missing authorization check.",
    },
  ];
  let calls = 0;
  const result = await compactReviewContext({
    history: history(),
    retained,
    knownEvidenceIds: new Set(["tool-1"]),
    /** Confirm immutable obligations stay out of the lossy summarization request. */
    async generate(messages) {
      calls++;
      const payload = JSON.parse(String(messages[1].content));
      assert.equal(payload.sequence, 1);
      assert.equal(payload.previousSummary, null);
      assert.deepEqual(payload.knownEvidenceIds, ["tool-1"]);
      assert.match(payload.transcriptFragment, /exited 1/);
      assert.doesNotMatch(JSON.stringify(messages), /abc123|def456|F-1/);
      return response(
        "tool-1 recorded an exit 1. Inspect the caller next; success is unknown.",
        ["tool-1"],
      );
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.slice(0, retained.length), retained);
  assert.equal(result[0], retained[0]);
  assert.equal(result[1], retained[1]);
  assert.equal(result.length, retained.length + 1);
  assert.match(String(result.at(-1)!.content), /success is unknown/);
  assert.match(String(result.at(-1)!.content), /cannot prove a finding/);
  assert.doesNotMatch(JSON.stringify(result), /full-output-marker/);
  assert.ok(result.every((message) => message.role !== "tool"));
});

test("oversized Unicode history is consumed once in bounded sequential fragments", async () => {
  const original: ModelMessage[] = [
    {
      role: "user",
      content: "tool-1 failed; caller unresolved. " + '💡"'.repeat(220_000),
    },
  ];
  const fragments: string[] = [];
  let stablePrompt: ModelMessage | undefined;
  const result = await compactReviewContext({
    history: original,
    retained: [{ role: "system", content: "Stable instructions" }],
    knownEvidenceIds: new Set(["tool-1"]),
    /** Record every fragment so the test can detect missing, duplicated or corrupt bytes. */
    async generate(messages) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(messages), "utf8") <=
          MAX_COMPACTION_INPUT_BYTES,
      );
      stablePrompt ??= messages[0];
      assert.deepEqual(messages[0], stablePrompt);
      const payload = JSON.parse(String(messages[1].content));
      fragments.push(payload.transcriptFragment);
      assert.equal(payload.sequence, fragments.length);
      if (fragments.length > 1)
        assert.equal(
          payload.previousSummary.notes,
          "tool-1 failed; inspect the unresolved caller next.",
        );
      assert.deepEqual(payload.knownEvidenceIds, ["tool-1"]);
      return response("tool-1 failed; inspect the unresolved caller next.");
    },
  });
  assert.ok(fragments.length > 2);
  assert.equal(fragments.join(""), JSON.stringify(original));
  assert.doesNotMatch(fragments.join(""), /�/);
  assert.equal(result.length, 2);
  assert.ok(Buffer.byteLength(String(result[1].content), "utf8") < 34_000);
});

test("compaction rejects unknown, unseen or duplicate evidence references", async () => {
  for (const turn of [
    response("tool-99 succeeded", ["tool-99"]),
    response("tool-2 succeeded", ["tool-2"]),
    response("tool-99 succeeded", []),
    response("tool-1 failed", ["tool-1", "tool-1"]),
  ]) {
    await assert.rejects(
      compactReviewContext({
        history: history(),
        retained: [],
        knownEvidenceIds: new Set(["tool-1", "tool-2"]),
        generate: async () => turn,
      }),
      /invalid summary or evidence reference/,
    );
  }
});

test("compaction fails closed on invalid, incomplete, tool-producing or oversized notes", async () => {
  const valid = response();
  for (const turn of [
    { ...valid, text: "not JSON" },
    { ...valid, text: JSON.stringify({ notes: "", evidenceIds: [] }) },
    {
      ...valid,
      text: JSON.stringify({ notes: "note", evidenceIds: [], extra: true }),
    },
    { ...valid, complete: false },
    { ...valid, tokenLimitReached: true },
    { ...valid, calls: [{ id: "call-1", name: "exec", arguments: {} }] },
    response("💡".repeat(10_000)),
  ]) {
    let calls = 0;
    await assert.rejects(
      compactReviewContext({
        history: history(),
        retained: [],
        knownEvidenceIds: new Set(["tool-1"]),
        /** Count requests to prove malformed output is never silently retried. */
        async generate() {
          calls++;
          return turn;
        },
      }),
      /Context compaction/,
    );
    assert.equal(calls, 1);
  }
});

test("compaction honors cancellation before and after a model request", async () => {
  for (const cancelBefore of [true, false]) {
    const controller = new AbortController();
    const reason = new Error("Review cancelled");
    let calls = 0;
    if (cancelBefore) controller.abort(reason);
    await assert.rejects(
      compactReviewContext({
        history: history(),
        retained: [],
        knownEvidenceIds: new Set(["tool-1"]),
        signal: controller.signal,
        /** Abort while the request is pending; its answer must not become continuation state. */
        async generate() {
          calls++;
          controller.abort(reason);
          return response();
        },
      }),
      (error) => error === reason,
    );
    assert.equal(calls, cancelBefore ? 0 : 1);
  }
});

test("compaction retains model failures and never retries or fabricates a note", async () => {
  const failure = new Error("Model request failed (HTTP 503)");
  let calls = 0;
  await assert.rejects(
    compactReviewContext({
      history: history(),
      retained: [],
      knownEvidenceIds: new Set(["tool-1"]),
      /** Preserve the original model failure for the attempt's failure accounting. */
      async generate() {
        calls++;
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("immutable context is bounded, tool-free and returned directly for empty history", async () => {
  let calls = 0;
  /** Any request would violate the no-history or invalid-retained-context contract. */
  const generate: Generate = async () => {
    calls++;
    return response();
  };
  const retained: ModelMessage[] = [{ role: "system", content: "objective" }];
  assert.deepEqual(
    await compactReviewContext({
      history: [],
      retained,
      knownEvidenceIds: new Set(),
      generate,
    }),
    retained,
  );
  for (const invalid of [
    [{ role: "user", content: "x".repeat(MAX_RETAINED_CONTEXT_BYTES) }],
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "exec",
            input: {},
          },
        ],
      },
    ],
  ] as ModelMessage[][]) {
    await assert.rejects(
      compactReviewContext({
        history: history(),
        retained: invalid,
        knownEvidenceIds: new Set(),
        generate,
      }),
      /Immutable review guidance|must not contain tool calls/,
    );
  }
  assert.equal(calls, 0);
});
