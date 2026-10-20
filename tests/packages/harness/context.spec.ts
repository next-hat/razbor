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
    Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 3),
  );
  assert.ok(
    estimateContextTokens(messages) <
      Buffer.byteLength(JSON.stringify(messages), "utf8"),
  );
  assert.equal(estimateContextTokens([]), 1);
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
      return response("tool-1 failed; inspect the unresolved caller next.", [
        "tool-1",
      ]);
    },
  });
  assert.ok(fragments.length > 2);
  assert.equal(fragments.join(""), JSON.stringify(original));
  assert.doesNotMatch(fragments.join(""), /�/);
  assert.equal(result.length, 2);
  assert.ok(Buffer.byteLength(String(result[1].content), "utf8") < 34_000);
});

test("compaction fragments fit the configured estimated input allowance without losing transcript bytes", async () => {
  const original: ModelMessage[] = [
    {
      role: "user",
      content: "tool-1 failed; caller unresolved. " + '💡"\\\n'.repeat(12_000),
    },
  ];
  const fragments: string[] = [];
  const sizes: number[] = [];
  const maxInputTokens = 6000;
  const result = await compactReviewContext({
    history: original,
    retained: [{ role: "system", content: "Stable instructions" }],
    knownEvidenceIds: new Set(["tool-1"]),
    maxInputTokens,
    /** Check the complete estimated request, including its growing continuation envelope. */
    async generate(messages) {
      assert.ok(estimateContextTokens(messages) + 1024 <= maxInputTokens);
      assert.ok(
        Buffer.byteLength(JSON.stringify(messages), "utf8") <=
          MAX_COMPACTION_INPUT_BYTES,
      );
      const payload = JSON.parse(String(messages[1].content));
      fragments.push(payload.transcriptFragment);
      sizes.push(Buffer.byteLength(payload.transcriptFragment));
      assert.equal(payload.sequence, fragments.length);
      if (fragments.length > 1)
        assert.match(payload.previousSummary.notes, /unresolved/);
      return response(
        "tool-1 remains unresolved. " + "relevant context ".repeat(350),
        ["tool-1"],
      );
    },
  });
  assert.ok(fragments.length > 2);
  assert.ok(
    sizes[1] < sizes[0],
    "the previous note must reduce the next fragment allowance",
  );
  assert.equal(fragments.join(""), JSON.stringify(original));
  assert.doesNotMatch(fragments.join(""), /�/);
  assert.equal(result.length, 2);
});

test("byte-boundary fragments preserve whole observation IDs without aliasing tool-12 to tool-1", async () => {
  const marker = "BOUNDARY";
  const template = JSON.stringify([{ role: "user", content: marker }]);
  const prefix = template.slice(0, template.indexOf(marker));
  const padding =
    300000 - Buffer.byteLength(JSON.stringify(prefix + " tool-1"));
  const original: ModelMessage[] = [
    {
      role: "user",
      content: "x".repeat(padding) + " tool-12 failed; caller unresolved.",
    },
  ];
  const fragments: string[] = [];
  const visible: string[][] = [];
  await compactReviewContext({
    history: original,
    retained: [],
    knownEvidenceIds: new Set(["tool-1", "tool-12"]),
    /** Record the visible references without accepting a boundary-created alias. */
    async generate(messages) {
      const payload = JSON.parse(String(messages[1].content));
      fragments.push(payload.transcriptFragment);
      visible.push(payload.knownEvidenceIds);
      assert.ok(!payload.knownEvidenceIds.includes("tool-1"));
      return response(
        "The observed failure remains unresolved.",
        payload.knownEvidenceIds,
      );
    },
  });
  assert.equal(fragments.join(""), JSON.stringify(original));
  assert.equal(fragments.length, 2);
  assert.deepEqual(visible, [[], ["tool-12"]]);
  assert.ok(fragments[1].startsWith("tool-12"));
});

test("a fragment boundary inside repository tool-12suffix text cannot expose a shorter known ID", async () => {
  const marker = "BOUNDARY";
  const template = JSON.stringify([{ role: "user", content: marker }]);
  const prefix = template.slice(0, template.indexOf(marker));
  const padding =
    300000 - Buffer.byteLength(JSON.stringify(prefix + " tool-1"));
  const original: ModelMessage[] = [
    {
      role: "user",
      content: "x".repeat(padding) + " tool-12suffix remains unresolved.",
    },
  ];
  const fragments: string[] = [];
  await compactReviewContext({
    history: original,
    retained: [],
    knownEvidenceIds: new Set(["tool-1", "tool-12"]),
    /** Repository words must not become references at an artificial fragment boundary. */
    async generate(messages) {
      const payload = JSON.parse(String(messages[1].content));
      fragments.push(payload.transcriptFragment);
      assert.deepEqual(payload.knownEvidenceIds, []);
      return response();
    },
  });
  assert.equal(fragments.join(""), JSON.stringify(original));
  assert.equal(fragments.length, 2);
});

test("adaptive-window fragments never split whole observation IDs", async () => {
  const original: ModelMessage[] = [
    {
      role: "user",
      content: " tool-12 failed; caller unresolved. ".repeat(2000),
    },
  ];
  const fragments: string[] = [];
  const maxInputTokens = 2500;
  await compactReviewContext({
    history: original,
    retained: [],
    knownEvidenceIds: new Set(["tool-1", "tool-12"]),
    maxInputTokens,
    /** Verify window limits and prohibit prefix aliases while the note changes fragment sizing. */
    async generate(messages) {
      assert.ok(estimateContextTokens(messages) + 1024 <= maxInputTokens);
      assert.ok(
        Buffer.byteLength(JSON.stringify(messages)) <=
          MAX_COMPACTION_INPUT_BYTES,
      );
      const payload = JSON.parse(String(messages[1].content));
      fragments.push(payload.transcriptFragment);
      assert.ok(!payload.knownEvidenceIds.includes("tool-1"));
      return response(
        "The observed failure remains unresolved.",
        payload.knownEvidenceIds,
      );
    },
  });
  const transcript = JSON.stringify(original);
  assert.equal(fragments.join(""), transcript);
  assert.ok(fragments.length > 2);
  const boundaries = new Set<number>();
  let offset = 0;
  for (const fragment of fragments) {
    offset += fragment.length;
    boundaries.add(offset);
  }
  for (const match of transcript.matchAll(/\btool-\d+\b/g))
    for (
      let index = match.index + 1;
      index < match.index + match[0].length;
      index++
    )
      assert.ok(
        !boundaries.has(index),
        "an observation ID must remain in one fragment",
      );
});

test("an enormous unknown repository tool-number literal remains ordinary bounded transcript text", async () => {
  const id = "tool-" + "1".repeat(300000);
  const original: ModelMessage[] = [
    { role: "user", content: " " + id + " remains unresolved." },
  ];
  const fragments: string[] = [];
  await compactReviewContext({
    history: original,
    retained: [],
    knownEvidenceIds: new Set(["tool-1"]),
    /** The unknown repository literal must neither block chunking nor alias a known short ID. */
    async generate(messages) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(messages)) <=
          MAX_COMPACTION_INPUT_BYTES,
      );
      const payload = JSON.parse(String(messages[1].content));
      fragments.push(payload.transcriptFragment);
      assert.deepEqual(payload.knownEvidenceIds, []);
      return response();
    },
  });
  assert.equal(fragments.join(""), JSON.stringify(original));
  assert.equal(fragments.length, 2);
});

test("compaction fails explicitly when its instruction or previous-note envelope cannot fit", async () => {
  for (const oversizedNote of [false, true]) {
    let calls = 0;
    await assert.rejects(
      compactReviewContext({
        history: [
          { role: "user", content: "unresolved hypothesis ".repeat(2000) },
        ],
        retained: [],
        knownEvidenceIds: new Set(),
        maxInputTokens: oversizedNote ? 2500 : 1024,
        /** Return a valid bounded note that cannot fit in the next small-window request. */
        async generate() {
          calls++;
          return response("unresolved hypothesis: " + "x".repeat(20_000));
        },
      }),
      /compaction.*envelope.*input.*limit/i,
    );
    assert.equal(calls, oversizedNote ? 1 : 0);
  }
});

test("compaction preserves repository strings resembling evidence IDs in free-text notes", async () => {
  const notes =
    "The dependency build-tool-3 prints tool-99; this repository text does not prove a successful check.";
  const result = await compactReviewContext({
    history: [
      {
        role: "user",
        content: "Source dependency build-tool-3 prints tool-99.",
      },
    ],
    retained: [],
    knownEvidenceIds: new Set(),
    generate: async () => response(notes),
  });
  assert.ok(String(result[0].content).includes(notes));
});

test("free-text notes do not authorize evidence references in later fragments", async () => {
  let calls = 0;
  await assert.rejects(
    compactReviewContext({
      history: [
        { role: "user", content: "tool-1 failed; " + "x".repeat(400000) },
      ],
      retained: [],
      knownEvidenceIds: new Set(["tool-1"]),
      /** Omit the structured reference first, then reject its attempted reuse after its fragment. */
      async generate() {
        calls++;
        return response(
          "tool-1 remains unresolved.",
          calls === 1 ? [] : ["tool-1"],
        );
      },
    }),
    /invalid summary or evidence reference/,
  );
  assert.equal(calls, 2);
});

test("compaction rejects unknown, unseen or duplicate evidence references", async () => {
  for (const turn of [
    response("tool-99 succeeded", ["tool-99"]),
    response("tool-2 succeeded", ["tool-2"]),
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
