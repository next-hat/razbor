import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

import pino, { type Logger } from "pino";

import { git } from "@razbor/harness/git";
import { RepositoryTools } from "@razbor/harness/repository";
import type { ReviewProgress } from "@razbor/contracts";

import { diffFixture } from "@tests/packages/harness/diff-fixture.js";

test("UTF-8 byte threshold chooses complete inline or manifest-only context", async () => {
  const f = await diffFixture();
  try {
    const prepared = await new RepositoryTools(f.repository).prepareDiff(
      f.base,
      f.head,
    );
    assert.equal(prepared.mode, "inline");
    assert.equal(prepared.coverage().unreadFiles, 1);
    prepared.markInlineSupplied();
    assert.equal(prepared.coverage().unreadFiles, 0);
    assert.equal(prepared.limitation(), "");
    for (const threshold of [
      0,
      Buffer.byteLength(prepared.patch) - 1,
      prepared.patch.length,
    ]) {
      const lazy = await new RepositoryTools(f.repository).prepareDiff(
        f.base,
        f.head,
        threshold,
      );
      assert.equal(lazy.mode, "lazy");
      assert.match(lazy.limitation(), /not fully supplied/);
      assert.doesNotMatch(lazy.manifest, /new implementation/);
    }
    const exact = await new RepositoryTools(f.repository).prepareDiff(
      f.base,
      f.head,
      Buffer.byteLength(prepared.patch),
    );
    assert.equal(exact.mode, "inline");
  } finally {
    await f.close();
  }
});

test("batch continuation reconstructs exact patches and preserves original hunk counters", async () => {
  const f = await diffFixture();
  try {
    const long = Array.from(
      { length: 850 },
      (_, i) => `line ${i}: ${"💡".repeat(8)}`,
    ).join("\n");
    await f.write("large.txt", long + "\n" + "💡".repeat(6500) + "\n");
    const head = await f.commit();
    const prepared = await new RepositoryTools(f.repository).prepareDiff(
      f.base,
      head,
      0,
    );
    const paths = prepared.files.map((file) => file.path);
    const patches = new Map<string, string>();
    let cursor: string | null = null;
    let pages = 0,
      splitLine = false,
      continuedHunk = false;
    do {
      const output = prepared.read({ paths, cursor });
      assert.ok(Buffer.byteLength(output) <= 12 * 1024);
      const page = JSON.parse(output);
      assert.equal(page.baselineSha, f.base);
      for (const section of page.sections) {
        const previous = patches.get(section.file.path) ?? "";
        assert.equal(section.offsetBytes, Buffer.byteLength(previous));
        assert.ok(!section.patch.includes("\uFFFD"));
        if (section.hunk.header) {
          continuedHunk = true;
          const completeLines = previous
            .split(/(?<=\n)/)
            .filter((s) => s.endsWith("\n"));
          const added = completeLines.filter(
            (s) => s.startsWith("+") && !s.startsWith("+++"),
          ).length;
          assert.equal(section.hunk.newLine, 1 + added);
          assert.equal(section.hunk.oldLine, 0);
        }
        splitLine ||= section.hunk.lineOffsetBytes > 0;
        patches.set(section.file.path, previous + section.patch);
      }
      cursor = page.cursor;
      assert.equal(page.remaining, !!cursor);
      assert.ok(++pages < 100);
      if (cursor) {
        assert.throws(() => prepared.read({ paths: ["related.ts"], cursor }));
        assert.throws(
          () => prepared.read({ paths: [...paths].reverse(), cursor }),
          /cursor/,
        );
      }
    } while (cursor);
    assert.equal([...patches.values()].join(""), prepared.patch);
    assert.ok(pages > 2 && splitLine && continuedHunk);
    assert.equal(prepared.coverage().remainingBytes, 0);
    assert.equal(
      prepared.coverage().suppliedBytes,
      Buffer.byteLength(prepared.patch),
    );
    assert.equal(prepared.limitation(), "");
    assert.throws(() =>
      prepared.read({ paths: ["large.txt"], cursor: "invented" }),
    );
    assert.throws(() => prepared.read({ paths: Array(9).fill("large.txt") }));
    const first = JSON.parse(prepared.read({ paths: ["large.txt"] }));
    assert.equal(
      JSON.parse(prepared.read({ paths: ["large.txt"] })).cursor,
      first.cursor,
    );
    const other = await new RepositoryTools(f.repository).prepareDiff(
      f.base,
      head,
      0,
    );
    assert.throws(() =>
      other.read({ paths: ["large.txt"], cursor: first.cursor }),
    );
  } finally {
    await f.close();
  }
});

test("NUL metadata retains rename, deletion, binary, modes, submodules and unusual literal filenames", async () => {
  const f = await diffFixture();
  try {
    const strange = 'new\tname\n"💡.txt';
    await rename(
      path.join(f.repository, "related.ts"),
      path.join(f.repository, strange),
    );
    await rm(path.join(f.repository, "source.ts"));
    await f.write(":(glob)*", "literal pathspec\n");
    await f.write("-option", "literal option\n");
    await f.write("binary", Buffer.from([0, 1, 2, 255]));
    await symlink("/etc/passwd", path.join(f.repository, "escape"));
    await git(f.repository, ["add", "--all"]);
    await git(f.repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${f.head},submodule`,
    ]);
    const head = await f.commit(false);
    const repo = new RepositoryTools(f.repository);
    const prepared = await repo.prepareDiff(f.base, head, 0);
    assert.ok(!prepared.manifest.includes("new\tname\n"));
    const renamed = prepared.files.find((file) => file.status === "renamed")!;
    assert.equal(renamed.path, strange);
    assert.equal(renamed.previousPath, "related.ts");
    assert.equal(
      prepared.files.find((file) => file.path === "binary")!.added,
      null,
    );
    assert.equal(
      prepared.files.find((file) => file.path === "submodule")!.content,
      "unsupported",
    );
    const page = JSON.parse(
      prepared.read({
        paths: [
          "related.ts",
          "source.ts",
          "binary",
          "escape",
          "submodule",
          ":(glob)*",
          "-option",
        ],
      }),
    );
    assert.ok(
      page.sections.some((s: { state: string }) => s.state === "binary"),
    );
    assert.equal(
      JSON.parse(await repo.readFile({ path: "source.ts" })).state,
      "absent",
    );
    assert.match(
      JSON.parse(
        await repo.readFile({ path: "source.ts", revision: "baseline" }),
      ).source,
      /old implementation/,
    );
    assert.equal(
      JSON.parse(
        await repo.readFile({ path: "related.ts", revision: "baseline" }),
      ).state,
      "available",
    );
    assert.equal(
      JSON.parse(await repo.readFile({ path: strange })).state,
      "available",
    );
    for (const name of ["escape", "submodule", "binary"])
      assert.equal(
        JSON.parse(await repo.readFile({ path: name })).state,
        "unsupported",
      );
    assert.match(
      JSON.parse(await repo.readFile({ path: ":(glob)*" })).source,
      /literal pathspec/,
    );
    assert.match(
      JSON.parse(await repo.readFile({ path: "-option" })).source,
      /literal option/,
    );
    assert.match(prepared.limitation(), /1 binary and 2 unsupported/);
    await chmod(path.join(f.repository, "-option"), 0o755);
    const modeHead = await f.commit();
    const mode = await new RepositoryTools(f.repository).prepareDiff(
      head,
      modeHead,
    );
    assert.equal(mode.files[0].content, "metadata");
    assert.equal(mode.files[0].added, 0);
    assert.notEqual(mode.files[0].oldMode, mode.files[0].newMode);
  } finally {
    await f.close();
  }
});

test("source ranges and diff stay pinned across dirty trees and moving refs; unsafe inputs and cancellation fail", async () => {
  const f = await diffFixture();
  try {
    await f.write("oversized", "x".repeat(100001));
    await f.write(
      "lines",
      Array.from({ length: 450 }, (_, i) => `value ${i}`).join("\n"),
    );
    await f.write("invalid-utf8", Buffer.from([255]));
    await f.write(".gitattributes", "invalid-utf8 -diff\n");
    const head = await f.commit();
    const abort = new AbortController();
    const repo = new RepositoryTools(f.repository, abort.signal);
    const prepared = await repo.prepareDiff(f.base, head, 0);
    await f.write("source.ts", "uncommitted work\n");
    await git(f.repository, ["update-ref", "refs/heads/moving", f.base]);
    await git(f.repository, ["update-ref", "HEAD", f.base]);
    assert.equal(
      JSON.parse(
        await repo.readFile({ path: "source.ts", startLine: 1, endLine: 1 }),
      ).source,
      "1 | new implementation 💡",
    );
    assert.equal(
      JSON.parse(
        await repo.readFile({
          path: "source.ts",
          revision: "baseline",
          startLine: 1,
          endLine: 1,
        }),
      ).source,
      "1 | old implementation",
    );
    assert.match(
      JSON.parse(await repo.readFile({ path: "related.ts" })).source,
      /related unchanged/,
    );
    assert.match(prepared.read({ paths: ["source.ts"] }), /new implementation/);
    assert.doesNotMatch(
      prepared.read({ paths: ["source.ts"] }),
      /uncommitted work/,
    );
    const lines = JSON.parse(await repo.readFile({ path: "lines" }));
    assert.equal(lines.endLine, 400);
    assert.equal(lines.nextStartLine, 401);
    assert.equal(
      JSON.parse(await repo.readFile({ path: "lines", startLine: 401 }))
        .nextStartLine,
      null,
    );
    assert.equal(
      JSON.parse(await repo.readFile({ path: "oversized" })).state,
      "unavailable",
    );
    assert.equal(
      JSON.parse(await repo.readFile({ path: "invalid-utf8" })).state,
      "unsupported",
    );
    for (const input of [
      { path: "/etc/passwd" },
      { path: "../outside" },
      { path: "a/../../outside" },
      { path: "source.ts", revision: "HEAD~1" },
      { path: "source.ts", startLine: 3, endLine: 1 },
      { path: "source.ts", command: "anything" },
    ])
      await assert.rejects(repo.readFile(input));
    assert.throws(() =>
      prepared.read({ paths: ["source.ts"], revision: "HEAD" }),
    );
    abort.abort();
    assert.throws(() => prepared.read({ paths: ["source.ts"] }));
    await assert.rejects(repo.readFile({ path: "source.ts" }));
    await assert.rejects(
      new RepositoryTools(f.repository, abort.signal).prepareDiff(f.base, head),
    );
  } finally {
    await f.close();
  }
});

test("comparison uses merge base once, not the recorded base tip or a later branch", async () => {
  const f = await diffFixture();
  try {
    await git(f.repository, ["checkout", "--detach", f.base]);
    await f.write("base-only", "not part of head changes\n");
    const baseTip = await f.commit();
    const prepared = await new RepositoryTools(f.repository).prepareDiff(
      baseTip,
      f.head,
      0,
    );
    assert.equal(prepared.baselineSha, f.base);
    assert.deepEqual(
      prepared.files.map((file) => file.path),
      ["source.ts"],
    );
    await assert.rejects(
      new RepositoryTools(f.repository).prepareDiff("a".repeat(40), f.head),
    );
  } finally {
    await f.close();
  }
});

test("autonomous turns use optional pinned reads and preserve limitations and usage", async (t) => {
  const globals = globalThis as typeof globalThis & { razborLogger?: Logger };
  const previousLogger = globals.razborLogger;
  globals.razborLogger = pino({ enabled: false });
  t.after(() => {
    globals.razborLogger = previousLogger;
  });
  const { reviewRepository } = await import("@razbor/harness");
  const f = await diffFixture();
  try {
    let scenario: "inline" | "unread" | "read" = "inline";
    let calls = 0;
    let toolsDisabled = false;
    const events: ReviewProgress[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init.body));
        if (toolsDisabled) assert.equal(body.tools, undefined);
        const input = body.input as {
          type?: string;
          name?: string;
          content?: unknown;
          output?: string;
        }[];
        const serialized = JSON.stringify(input);
        assert.doesNotMatch(
          serialized,
          /harness is now running the .* checkpoint|Recorded evidence IDs/,
        );
        if (calls === 1) {
          if (scenario === "inline")
            assert.match(serialized, /new implementation/);
          else
            assert.doesNotMatch(
              serialized,
              /new implementation|old implementation/,
            );
        }
        const issued = input.filter(
          (message) => message.type === "function_call",
        );
        const tool =
          scenario === "read" && issued.length < 2
            ? ["read_diff", "read_file"][issued.length]
            : undefined;
        return new Response(
          JSON.stringify({
            id: "fixture",
            object: "response",
            created_at: 0,
            status: "completed",
            model: "fixture",
            output: [
              tool
                ? {
                    id: "diff-function",
                    type: "function_call",
                    status: "completed",
                    call_id: `source-call-${calls}`,
                    name: tool,
                    arguments: JSON.stringify(
                      tool === "read_diff"
                        ? { paths: ["source.ts"] }
                        : { path: "source.ts" },
                    ),
                  }
                : {
                    id: "diff-message",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: JSON.stringify({
                          summary:
                            "No actionable findings in inspected changes.",
                          findings: [],
                        }),
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
              input_tokens_details:
                scenario === "read" ? undefined : { cached_tokens: 50 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
    for (const mode of ["inline", "unread", "read"] as const) {
      scenario = mode;
      calls = 0;
      events.length = 0;
      const review = await reviewRepository(f.repository, f.base, f.head, {
        baseUrl: "http://fixture.invalid/v1",
        apiKey: "fixture",
        model: "fixture",
        reasoningEffort: "low",
        reviewId: "fixture",
        initialDiffMaxBytes: mode === "inline" ? 4096 : 0,
        /** Collect safe progress and cumulative usage for the completed attempt. */
        onProgress: (event) => events.push(event),
      });
      if (mode === "unread")
        assert.match(review.summary, /coverage limitation/);
      else assert.doesNotMatch(review.summary, /coverage limitation/);
      assert.equal(calls, mode === "read" ? 3 : 1);
      assert.equal(
        events.at(-1)!.cachedInputTokens,
        mode === "read" ? undefined : calls * 50,
      );
      assert.equal(events.at(-1)!.inputTokens, calls * 100);
      assert.equal(events.at(-1)!.outputTokens, calls * 10);
      assert.doesNotMatch(
        JSON.stringify(events),
        /new implementation|old implementation/,
      );
    }
    toolsDisabled = true;
    scenario = "inline";
    calls = 0;
    await reviewRepository(f.repository, f.base, f.head, {
      baseUrl: "http://fixture.invalid/v1",
      apiKey: "fixture",
      model: "fixture",
      reasoningEffort: "low",
      reviewId: "fixture",
      supportsTools: false,
    });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(
      reviewRepository(f.repository, f.base, f.head, {
        baseUrl: "http://fixture.invalid/v1",
        apiKey: "fixture",
        model: "fixture",
        reasoningEffort: "low",
        reviewId: "fixture",
        supportsTools: false,
        initialDiffMaxBytes: 0,
      }),
      /tool capability required/,
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("modified multi-hunk pages retain old/new source line locations under a smaller output bound", async () => {
  const f = await diffFixture();
  try {
    const before = Array.from(
      { length: 600 },
      (_, i) => `before ${i + 1} ${"x".repeat(30)}`,
    );
    await f.write("hunks", before.join("\n") + "\n");
    const baseline = await f.commit();
    const after = before.map((line, i) =>
      i < 180 || i > 400 ? line.replace("before", "after") : line,
    );
    await f.write("hunks", after.join("\n") + "\n");
    const head = await f.commit();
    const prepared = await new RepositoryTools(f.repository).prepareDiff(
      baseline,
      head,
      0,
      2048,
    );
    let cursor: string | null = null,
      reconstructed = "",
      pages = 0,
      checkedOld = false,
      checkedNew = false;
    do {
      const result = prepared.read({ paths: ["hunks"], cursor });
      assert.ok(Buffer.byteLength(result) <= 2048);
      const page = JSON.parse(result);
      for (const section of page.sections) {
        if (section.hunk.header && section.hunk.lineOffsetBytes === 0) {
          const line = section.patch.split("\n")[0];
          if (line.startsWith("-")) {
            assert.equal(line.slice(1), before[section.hunk.oldLine - 1]);
            checkedOld = true;
          }
          if (line.startsWith("+")) {
            assert.equal(line.slice(1), after[section.hunk.newLine - 1]);
            checkedNew = true;
          }
          if (line.startsWith("@@")) assert.equal(section.hunk.header, line);
        }
        reconstructed += section.patch;
      }
      cursor = page.cursor;
      assert.ok(++pages < 100);
    } while (cursor);
    assert.equal(reconstructed, prepared.patch);
    assert.ok(checkedOld && checkedNew);
    assert.equal(prepared.coverage().remainingBytes, 0);
  } finally {
    await f.close();
  }
});

test("deletion-only changes retain baseline evidence without inventing new-side added anchors", async () => {
  const f = await diffFixture();
  try {
    await f.write("source.ts", "guard();\nwork();\n");
    const baseline = await f.commit();
    await f.write("source.ts", "work();\n");
    await rm(path.join(f.repository, "related.ts"));
    const deletedHead = await f.commit();
    const tools = new RepositoryTools(f.repository);
    const deleted = await tools.prepareDiff(baseline, deletedHead);
    assert.equal(
      deleted.files.find((file) => file.path === "source.ts")?.added,
      0,
    );
    assert.equal(deleted.validFindingRange("source.ts", 1, 1), false);
    assert.equal(deleted.validFindingRange("related.ts", 1, 1), false);
    assert.match(
      JSON.parse(
        await tools.readFile({ path: "source.ts", revision: "baseline" }),
      ).source,
      /guard/,
    );
    assert.match(
      JSON.parse(await tools.readFile({ path: "source.ts" })).source,
      /work/,
    );
    assert.equal(
      JSON.parse(await tools.readFile({ path: "related.ts" })).state,
      "absent",
    );
    await f.write("source.ts", "work();\ncleanup();\n");
    const addedHead = await f.commit();
    const added = await new RepositoryTools(f.repository).prepareDiff(
      baseline,
      addedHead,
    );
    assert.equal(added.validFindingRange("source.ts", 2, 2), true);
    assert.equal(added.validFindingRange("source.ts", 1, 1), false);
    assert.equal(added.validFindingRange("source.ts", 1, 3), false);
  } finally {
    await f.close();
  }
});
