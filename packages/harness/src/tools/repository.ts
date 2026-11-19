import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { z } from "zod";

import { commitSchema } from "@razbor/contracts";

import { PreparedDiff } from "@harness/src/tools/diff.js";
import { execSearchPath } from "@harness/src/tools/exec.js";
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

type LineRange = { start: number; end: number };

type DeliveredPage = LineRange & { totalLines: number };

type SourceReads = { supplied: LineRange[]; clipped: LineRange[] };

type FailedRead = {
  path: string;
  revision: "head" | "baseline";
  ranges: LineRange[];
};

/** Check whether the returned pages cover a requested interval, including out-of-order reads. */
function coversLines(pages: LineRange[], range: LineRange) {
  let next = range.start;
  for (const page of pages) {
    if (page.start > next) break;
    next = Math.max(next, page.end + 1);
    if (next > range.end) return true;
  }
  return false;
}

/** Identify exact UTF-8 source text independently of the repository's object format. */
function sourceDigest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/** Subtract delivered lines on both sides of a requested interval; a confirmed EOF also settles lines beyond the file. */
function subtractPage(ranges: LineRange[], page: DeliveredPage) {
  const remaining: LineRange[] = [];
  for (const { start, end } of ranges) {
    const last = Math.min(end, page.totalLines);
    const beforeEnd = Math.min(last, page.start - 1);
    if (start <= beforeEnd) remaining.push({ start, end: beforeEnd });
    const afterStart = Math.max(start, page.end + 1);
    if (afterStart <= last) remaining.push({ start: afterStart, end: last });
  }
  return remaining;
}

export class RepositoryTools {
  private readonly sourceReads = new Map<string, SourceReads>();
  private readonly deliveredPages = new Map<string, DeliveredPage[]>();
  private readonly failedReads = new Map<string, FailedRead>();
  private readonly completeExecSources = new Set<string>();
  private readonly emptyExecObjects = new Set<string>();
  private longestExecSourceBytes = 0;

  /** Remember an identifiable failed request on this pinned comparison. Malformed requests cannot be reconciled. */
  recordFailedRead(input: unknown) {
    const parsed = readFileArguments.safeParse(input);
    if (!parsed.success) return false;
    const { path, revision, startLine, endLine } = parsed.data;
    const start = startLine ?? 1;
    const end = endLine ?? start + 399;
    if (end < start) return false;
    const key = JSON.stringify([path, revision ?? "head"]);
    let missing = [{ start, end }];
    for (const page of this.deliveredPages.get(key) ?? []) {
      missing = subtractPage(missing, page);
      if (!missing.length) return true;
    }
    const request = this.failedReads.get(key) ?? {
      path,
      revision: revision ?? "head",
      ranges: [],
    };
    request.ranges.push(...missing);
    this.failedReads.set(key, request);
    return true;
  }

  /** Retain intact pages and confirmed EOF or absence for earlier and later failed reads of this pinned path. */
  observeSourceRead(
    read: { path: string; revision: string } & (
      | { state: "absent" }
      | {
          state: "available";
          startLine: number;
          endLine: number;
          totalLines: number;
        }
    ),
  ) {
    const key = JSON.stringify([read.path, read.revision]);
    const page =
      read.state === "available"
        ? {
            start: read.startLine,
            end: read.endLine,
            totalLines: read.totalLines,
          }
        : { start: 1, end: 0, totalLines: 0 };
    const delivered = this.deliveredPages.get(key) ?? [];
    delivered.push(page);
    this.deliveredPages.set(key, delivered);
    const request = this.failedReads.get(key);
    if (!request) return;
    const remaining = subtractPage(request.ranges, page);
    if (remaining.length) request.ranges = remaining;
    else this.failedReads.delete(key);
  }

  /** Check outstanding ranges against complete exec output, including when the pinned tree was unavailable at read time. */
  async hasFailedReads() {
    if (!this.completeExecSources.size && !this.emptyExecObjects.size)
      return this.failedReads.size > 0;
    for (const { path, revision } of this.failedReads.values()) {
      try {
        const entry = await this.sourceEntry(path, revision);
        if (
          entry?.type !== "blob" ||
          !["100644", "100755"].includes(entry.mode)
        )
          return true;
        // A larger blob cannot match any delivered output. Git requires a positive buffer limit even for an empty blob.
        const content = await git(
          this.repository,
          ["cat-file", "blob", entry.oid],
          this.signal,
          false,
          Math.max(1, this.longestExecSourceBytes),
        );
        const supplied = content
          ? this.completeExecSources.has(sourceDigest(content))
          : this.emptyExecObjects.has(`${entry.sha}:${path}`);
        if (!supplied) return true;
      } catch {
        this.signal?.throwIfAborted();
        return true;
      }
    }
    return false;
  }

  /** Match complete text by content. Empty output needs a Git command explicitly reading the requested pinned object. */
  observeExec(stdout: string, argv?: unknown, searchPath?: string) {
    if (stdout === "") {
      if (!Array.isArray(argv)) return;
      const [command, operation, subject, object] = argv;
      const candidates = execSearchPath(searchPath)
        .split(path.delimiter)
        .map((dir) => path.join(dir, "git"));
      const checkout = path.resolve(this.repository) + path.sep;
      // A caller-selected checkout program named git cannot establish an empty observation.
      const installed = candidates.filter((file) => !file.startsWith(checkout));
      const trusted =
        command === "git"
          ? installed.length === candidates.length
          : installed.includes(command);
      if (!trusted) return;
      // Only an exact SHA:tree-path can match a failed read. Git's ./ and ../ operands depend on the exec cwd.
      if (
        argv.length === 3 &&
        operation === "show" &&
        typeof subject === "string"
      )
        this.emptyExecObjects.add(subject);
      else if (
        argv.length === 4 &&
        operation === "cat-file" &&
        subject === "blob" &&
        typeof object === "string"
      )
        this.emptyExecObjects.add(object);
      return;
    }
    if (stdout.includes("\0")) return;
    this.completeExecSources.add(sourceDigest(stdout));
    this.longestExecSourceBytes = Math.max(
      this.longestExecSourceBytes,
      Buffer.byteLength(stdout),
    );
  }

  /** Count immutable files with a requested interval still missing from the delivered evidence. */
  unfinishedSourceReads() {
    let count = 0;
    for (const [digest, reads] of this.sourceReads) {
      if (!reads.clipped.length || this.completeExecSources.has(digest))
        continue;
      reads.supplied.sort((a, b) => a.start - b.start);
      if (reads.clipped.some((range) => !coversLines(reads.supplied, range)))
        count++;
    }
    return count;
  }

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
    const page = sourcePage(content, metadata, endLine);
    if (page.state === "available") {
      const digest = sourceDigest(content);
      const reads = this.sourceReads.get(digest) ?? {
        supplied: [],
        clipped: [],
      };
      reads.supplied.push({ start: startLine, end: page.endLine });
      const requestedEnd = Math.min(page.totalLines, endLine);
      if (page.endLine < requestedEnd)
        reads.clipped.push({ start: page.endLine + 1, end: requestedEnd });
      this.sourceReads.set(digest, reads);
    }
    return JSON.stringify(page);
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
 * Builds a numbered source page within serialized line and byte limits, including a
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
    state: "available" as const,
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
    return {
      ...metadata,
      state: "unavailable" as const,
      reason: "source line exceeds response limit",
    };
  return result();
}
