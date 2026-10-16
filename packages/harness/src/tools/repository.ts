import path from "node:path";
import { promises as fs } from "node:fs";

import { z } from "zod";

import { commitSchema } from "@razbor/contracts";

import { PreparedDiff } from "@harness/src/tools/diff.js";
import { git, MAX_GIT_OUTPUT_BYTES } from "@harness/src/git.js";

const MAX_FILE_BYTES = 100_000;

const MAX_SOURCE_BLOB_BYTES = MAX_GIT_OUTPUT_BYTES;

export const gitDiffArguments = z.object({
  base: commitSchema,
  head: commitSchema,
});

export const readFileArguments = z
  .object({
    path: z.string().min(1).max(4096),
    revision: z.enum(["head", "baseline"]).nullish(),
    startLine: z.number().int().positive().safe().nullish(),
    endLine: z.number().int().positive().safe().nullish(),
  })
  .strict();

export class RepositoryTools {
  private revisions?: { head: string; baseline: string };

  /**
   * Binds repository access to a checkout and cancellation signal; comparison revisions
   * are pinned separately before source reads.
   */
  constructor(
    private readonly repository: string,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Pins a comparison once, resolving the merge base when no baseline is supplied and
   * verifying both commits before preparing diff pages.
   */
  async prepareDiff(
    base: string,
    head: string,
    threshold = 4096,
    outputBytes = 12 * 1024,
    baseline?: string,
  ) {
    commitSchema.parse(base);
    commitSchema.parse(head);
    if (this.revisions) throw new Error("Review comparison already pinned");
    const pinnedBaseline = baseline
      ? commitSchema.parse(baseline)
      : commitSchema.parse(
          await git(this.repository, ["merge-base", base, head], this.signal),
        );
    for (const sha of [pinnedBaseline, head]) {
      if (
        (await git(
          this.repository,
          ["rev-parse", "--verify", `${sha}^{commit}`],
          this.signal,
        )) !== sha
      )
        throw new Error("Required review commit unavailable");
    }
    this.revisions = { head, baseline: pinnedBaseline };
    return PreparedDiff.prepare(
      this.repository,
      pinnedBaseline,
      head,
      threshold,
      outputBytes,
      this.signal,
    );
  }

  /**
   * Validates and pins a comparison, returning its complete patch or the no-diff
   * marker.
   */
  async gitDiff(input: unknown) {
    const { base, head } = gitDiffArguments.parse(input);
    return (await this.prepareDiff(base, head)).patch || "(no diff)";
  }

  /**
   * Looks up an exact path in a pinned Git tree, rejecting traversal or malformed
   * entries and returning null when absent.
   */
  async sourceEntry(
    relativePath: string,
    revision: "head" | "baseline" = "head",
  ) {
    this.signal?.throwIfAborted();
    if (!this.revisions) throw new Error("Review comparison is not pinned");
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      relativePath
        .split(/[\\/]/)
        .some((p) => p === ".." || p === "." || p === "")
    )
      throw new Error("Invalid repository-relative path");
    const sha = this.revisions[revision];
    const row = await git(
      this.repository,
      ["ls-tree", "-z", sha, "--", relativePath],
      this.signal,
      false,
    );
    if (!row) return null;
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]*)\0$/.exec(
      row,
    );
    if (match?.[4] !== relativePath) throw new Error("Invalid source object");
    return { mode: match[1], type: match[2], oid: match[3], sha };
  }

  /**
   * Reads bounded pages from immutable head or baseline blobs. Reports absent,
   * unsupported, or oversized source explicitly without reading the working tree.
   */
  async readFile(input: unknown) {
    const args = readFileArguments.parse(input);
    const revision = args.revision ?? "head",
      startLine = args.startLine ?? 1;
    const endLine = args.endLine ?? startLine + 399;
    if (endLine < startLine) throw new Error("read_file range is reversed");
    const entry = await this.sourceEntry(args.path, revision);
    const metadata = {
      path: args.path,
      revision,
      sha: this.revisions![revision],
      startLine,
    };
    if (!entry) return JSON.stringify({ ...metadata, state: "absent" });
    if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob")
      return JSON.stringify({
        ...metadata,
        state: "unsupported",
        mode: entry.mode,
      });
    const bytes = Number(
      await git(this.repository, ["cat-file", "-s", entry.oid], this.signal),
    );
    if (!Number.isSafeInteger(bytes) || bytes > MAX_SOURCE_BLOB_BYTES)
      return JSON.stringify({
        ...metadata,
        state: "unavailable",
        reason: `blob exceeds ${MAX_SOURCE_BLOB_BYTES}-byte source ingestion limit`,
        bytes,
      });
    let content: string;
    try {
      content = await git(
        this.repository,
        ["cat-file", "blob", entry.oid],
        this.signal,
        false,
        MAX_SOURCE_BLOB_BYTES,
      );
    } catch (error) {
      if (error instanceof TypeError && !this.signal?.aborted)
        return JSON.stringify({
          ...metadata,
          state: "unsupported",
          reason: "source is not UTF-8",
        });
      throw error;
    }
    if (content.includes("\0"))
      return JSON.stringify({
        ...metadata,
        state: "unsupported",
        reason: "binary source",
      });
    return sourcePage(content, metadata, endLine);
  }

  /**
   * Resolves an existing working-tree file and rejects paths or resolved symlinks that
   * escape the repository root.
   */
  async resolveRepositoryFile(relativePath: string) {
    if (path.isAbsolute(relativePath)) throw new Error("path must be relative");
    const root = await fs.realpath(this.repository);
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("path escapes the repository");
    const f = await fs.realpath(candidate);
    if (!(await fs.stat(f)).isFile())
      throw new Error("path does not point to a file");
    const rr = path.relative(root, f);
    if (rr === ".." || rr.startsWith(`..${path.sep}`) || path.isAbsolute(rr))
      throw new Error("path escapes the repository");
    return f;
  }
}

/**
 * Formats an exception as model-visible tool failure text so the caller can recover
 * within the review.
 */
export function toolError(e: unknown) {
  return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Serializes a numbered source page within line and byte limits, including a
 * continuation line or an explicit oversized-line state.
 */
function sourcePage(
  content: string,
  metadata: { path: string; revision: string; sha: string; startLine: number },
  endLine: number,
) {
  const { startLine } = metadata;
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  const last = Math.min(endLine, startLine + 399, lines.length);
  const source: string[] = [];
  let next = startLine;
  /**
   * Builds page metadata from the currently accepted lines so byte-budget checks
   * measure the full serialized response.
   */
  const result = () => ({
    ...metadata,
    state: "available",
    endLine: next - 1,
    totalLines: lines.length,
    source: source.join("\n"),
    truncated: next <= lines.length,
    nextStartLine: next <= lines.length ? next : null,
  });
  while (next <= last) {
    const line = `${next} | ${lines[next - 1]}`;
    source.push(line);
    next++;
    if (Buffer.byteLength(JSON.stringify(result())) > MAX_FILE_BYTES) {
      source.pop();
      next--;
      break;
    }
  }
  if (!source.length && next <= last)
    return JSON.stringify({
      ...metadata,
      state: "unavailable",
      reason: "source line exceeds response limit",
    });
  return JSON.stringify(result());
}
