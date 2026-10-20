import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { git, MAX_GIT_OUTPUT_BYTES } from "@harness/src/git.js";

const MAX_INPUT_BYTES = 1_000_000;

export const readDiffArguments = z
  .object({
    paths: z.array(z.string().min(1)).min(1).max(8),
    cursor: z.string().max(64).nullish(),
  })
  .strict();

export type ChangedFile = {
  status: string;
  path: string;
  previousPath?: string;
  headPath: string | null;
  baselinePath: string | null;
  oldMode: string;
  newMode: string;
  added: number | null;
  deleted: number | null;
  content: "text" | "metadata" | "binary" | "unsupported";
};

const diffOptions = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--ignore-submodules=none",
  "--submodule=short",
];

/**
 * Splits NUL-delimited Git metadata, rejecting output that ends with an incomplete
 * record.
 */
function records(output: string) {
  if (output && !output.endsWith("\0"))
    throw new Error("Incomplete diff metadata");
  return output ? output.slice(0, -1).split("\0") : [];
}

/**
 * Parses numstat records into per-path line counts, handling rename records and
 * preserving null counts for binary changes.
 */
function diffCounts(numstat: string) {
  const stats = records(numstat);
  const counts = new Map<
    string,
    { added: number | null; deleted: number | null }
  >();
  for (let i = 0; i < stats.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[i]);
    if (!match) throw new Error("Invalid diff statistics");
    let name = match[3];
    if (!name) {
      i++; // old name is a separate NUL record
      name = stats[++i];
    }
    if (!name) throw new Error("Incomplete rename statistics");
    counts.set(name, {
      added: match[1] === "-" ? null : Number(match[1]),
      deleted: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return counts;
}

/**
 * Classifies changed content from file-mode support and numstat counts, distinguishing
 * binary, metadata-only, and textual changes.
 */
function contentKind(
  unsupported: boolean,
  stat: { added: number | null; deleted: number | null },
): ChangedFile["content"] {
  if (unsupported) return "unsupported";
  if (stat.added === null || stat.deleted === null) return "binary";
  if (stat.added === 0 && stat.deleted === 0) return "metadata";
  return "text";
}

/**
 * Combines raw diff records and statistics into changed-file metadata, preserving old
 * and new paths and rejecting inconsistent records.
 */
function manifest(raw: string, numstat: string): ChangedFile[] {
  const counts = diffCounts(numstat);
  const rows = records(raw);
  const files: ChangedFile[] = [];
  const statuses: Record<string, string> = {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
    C: "copied",
    T: "type-changed",
  };
  for (let i = 0; i < rows.length; i++) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(
      rows[i],
    );
    if (!match) throw new Error("Invalid changed-file metadata");
    const oldPath = rows[++i];
    const renamed = ["R", "C"].includes(match[3]);
    const name = renamed ? rows[++i] : oldPath;
    if (!name || !oldPath) throw new Error("Incomplete changed-file metadata");
    const stat = counts.get(name);
    if (!stat) throw new Error("Missing changed-file statistics");
    const unsupported = [match[1], match[2]].some(
      (mode) => !["000000", "100644", "100755"].includes(mode),
    );
    files.push({
      status: statuses[match[3]] ?? match[3],
      path: name,
      ...(renamed ? { previousPath: oldPath } : {}),
      headPath: match[3] === "D" ? null : name,
      baselinePath: match[3] === "A" ? null : oldPath,
      oldMode: match[1],
      newMode: match[2],
      ...stat,
      content: contentKind(unsupported, stat),
    });
  }
  return files;
}

type Position = { file: number; offset: number };

/**
 * Locates the original hunk and line counters for a patch fragment. Preserves a byte
 * offset when a source line spans pages without rewriting patch text.
 */
function hunkPosition(patch: string, offset: number) {
  const upcoming = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*)/.exec(
    patch.slice(offset),
  );
  if (upcoming)
    return {
      header: upcoming[1],
      oldLine: Number(upcoming[2]),
      newLine: Number(upcoming[3]),
      lineOffsetBytes: 0,
    };
  let oldLine = 0,
    newLine = 0,
    header: string | null = null,
    lineStart = 0;
  for (const line of patch.slice(0, offset).split(/(?<=\n)/)) {
    if (!line.endsWith("\n")) break;
    lineStart += line.length;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      header = line.trimEnd();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (header) {
      if (line.startsWith(" ") || line.startsWith("-")) oldLine++;
      if (line.startsWith(" ") || line.startsWith("+")) newLine++;
    }
  }
  return {
    header,
    oldLine,
    newLine,
    lineOffsetBytes: Buffer.byteLength(patch.slice(lineStart, offset)),
  };
}

export class PreparedDiff {
  private readonly nonce = randomUUID();
  private readonly cursors = new Map<
    string,
    { selection: number[]; position: Position }
  >();
  private readonly supplied = new Map<number, number>();
  readCalls = 0;
  returnedBytes = 0;
  readonly manifest: string;
  readonly mode: "inline" | "lazy";

  /**
   * Stores immutable comparison patches, rejects an oversized manifest, and selects
   * inline or lazy delivery from the configured threshold.
   */
  private constructor(
    readonly baselineSha: string,
    readonly headSha: string,
    readonly files: ChangedFile[],
    readonly patch: string,
    private readonly patches: string[],
    readonly threshold: number,
    private readonly outputBytes: number,
    private readonly signal?: AbortSignal,
    private readonly parent?: { diff: PreparedDiff; offset: number },
  ) {
    this.manifest = JSON.stringify(files);
    if (Buffer.byteLength(this.manifest) > MAX_INPUT_BYTES)
      throw new Error("Changed-file manifest exceeds input limit");
    this.mode =
      Buffer.byteLength(patch) <= threshold &&
      !(threshold === 0 && files.length)
        ? "inline"
        : "lazy";
  }

  /**
   * Reads raw metadata, statistics, and patches for the pinned comparison and rejects
   * mismatches between files and patch sections. Only full patch ingestion uses the
   * larger buffer; metadata and model-facing pages keep their separate small limits.
   */
  static async prepare(
    repository: string,
    baselineSha: string,
    headSha: string,
    threshold: number,
    outputBytes: number,
    signal?: AbortSignal,
  ) {
    const compare = [baselineSha, headSha, "--"];
    const raw = await git(
      repository,
      [...diffOptions, "--raw", "-z", ...compare],
      signal,
      false,
    );
    const stats = await git(
      repository,
      [...diffOptions, "--numstat", "-z", ...compare],
      signal,
      false,
    );
    const patch = await git(
      repository,
      [...diffOptions, "--unified=5", ...compare],
      signal,
      false,
      MAX_GIT_OUTPUT_BYTES,
    );
    const files = manifest(raw, stats);
    const patches = patch ? patch.split(/(?=^diff --git )/m) : [];
    if (patches.length !== files.length)
      throw new Error("Incomplete changed-file patches");
    return new PreparedDiff(
      baselineSha,
      headSha,
      files,
      patch,
      patches,
      threshold,
      outputBytes,
      signal,
    );
  }

  /** Validates a new-side finding against one immutable changed hunk ending on an added line. */
  validFindingRange(path: string, start: number, end: number): boolean {
    const index = this.files.findIndex((file) => file.headPath === path);
    if (index < 0) return false;
    let line = 0;
    let hunkStart = 0;
    let hunkEnd = -1;
    for (const text of this.patches[index].split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (header) {
        line = hunkStart = Number(header[1]);
        hunkEnd = hunkStart + Number(header[2] ?? 1) - 1;
      } else if (hunkEnd >= 0 && text.startsWith("+")) {
        if (line === end && start >= hunkStart && end <= hunkEnd) return true;
        line++;
      } else if (text.startsWith(" ")) line++;
    }
    return false;
  }

  /**
   * Partitions files once in manifest order while retaining pinned revisions and page
   * bounds. Multi-group views inline bounded patches; oversized single files page
   * lazily. Each view owns its cursors and forwards exposure metrics to this parent.
   */
  groups(maxPatchBytes = 512 * 1024, maxFiles = 96): PreparedDiff[] {
    if (
      !Number.isSafeInteger(maxPatchBytes) ||
      maxPatchBytes < 1 ||
      maxPatchBytes > MAX_INPUT_BYTES ||
      !Number.isSafeInteger(maxFiles) ||
      maxFiles < 1
    )
      throw new RangeError("Invalid diff group limits");
    if (!this.files.length) return [this];
    const ranges: { start: number; end: number; bytes: number }[] = [];
    let start = 0;
    let bytes = 0;
    for (let index = 0; index < this.files.length; index++) {
      const size = Buffer.byteLength(this.patches[index]);
      if (
        index > start &&
        (index - start >= maxFiles || bytes + size > maxPatchBytes)
      ) {
        ranges.push({ start, end: index, bytes });
        start = index;
        bytes = 0;
      }
      bytes += size;
    }
    ranges.push({ start, end: this.files.length, bytes });
    if (ranges.length === 1) return [this];
    return ranges.map(({ start, end, bytes }) => {
      const patches = this.patches.slice(start, end);
      return new PreparedDiff(
        this.baselineSha,
        this.headSha,
        this.files.slice(start, end),
        patches.join(""),
        patches,
        bytes > maxPatchBytes
          ? maxPatchBytes
          : Math.min(MAX_INPUT_BYTES, Math.max(this.threshold, maxPatchBytes)),
        this.outputBytes,
        this.signal,
        { diff: this, offset: start },
      );
    });
  }

  /** Update supplied offsets monotonically in this view and every containing diff. */
  private markSupplied(index: number, end: number) {
    this.supplied.set(index, Math.max(this.supplied.get(index) ?? 0, end));
    this.parent?.diff.markSupplied(this.parent.offset + index, end);
  }

  /** Forward attempted-read counts or successful response bytes without duplicating them. */
  private recordRead(bytes?: number) {
    if (bytes === undefined) this.readCalls++;
    else this.returnedBytes += bytes;
    this.parent?.diff.recordRead(bytes);
  }

  /**
   * Marks all supported patch content as supplied only when the complete diff was
   * included inline, propagating exposure without treating it as a tool read.
   */
  markInlineSupplied() {
    if (this.mode !== "inline") return;
    this.files.forEach((f, i) => {
      if (f.content === "text" || f.content === "metadata")
        this.markSupplied(i, this.patches[i].length);
    });
  }

  /**
   * Counts supplied and unread patch bytes separately from binary and unsupported
   * files; these are exposure metrics, not proof of review completeness.
   */
  coverage() {
    let suppliedBytes = 0,
      remainingBytes = 0,
      unreadFiles = 0,
      binaryFiles = 0,
      unsupportedFiles = 0;
    this.files.forEach((f, i) => {
      if (f.content === "binary") {
        binaryFiles++;
        return;
      }
      if (f.content === "unsupported") {
        unsupportedFiles++;
        return;
      }
      const offset = this.supplied.get(i) ?? 0;
      suppliedBytes += Buffer.byteLength(this.patches[i].slice(0, offset));
      remainingBytes += Buffer.byteLength(this.patches[i].slice(offset));
      if (offset < this.patches[i].length) unreadFiles++;
    });
    return {
      suppliedBytes,
      remainingBytes,
      unreadFiles,
      binaryFiles,
      unsupportedFiles,
    };
  }

  /**
   * Describes unread or uninspectable changes for the final summary, returning an empty
   * string when no exposure limitation remains.
   */
  limitation() {
    const c = this.coverage();
    return c.unreadFiles || c.binaryFiles || c.unsupportedFiles
      ? `Review limitation: ${c.unreadFiles} textual/metadata changes were not fully supplied (${c.remainingBytes} patch bytes remaining); ${c.binaryFiles} binary and ${c.unsupportedFiles} unsupported changes were not inspected. Content exposure does not establish exhaustive review.`
      : "";
  }

  /**
   * Finds the largest fragment that fits the serialized response, then favors hunk or
   * line boundaries and avoids splitting surrogate pairs.
   */
  private patchEnd(
    patch: string,
    start: number,
    section: { patch: string; hunk: ReturnType<typeof hunkPosition> },
    fits: () => boolean,
  ) {
    // Measure the serialized envelope, including JSON escaping and metadata.
    let low = start,
      high = Math.min(patch.length, start + this.outputBytes);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      section.patch = patch.slice(start, mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    let end = low;
    if (
      end > start &&
      end < patch.length &&
      /[\uD800-\uDBFF]/.test(patch[end - 1])
    )
      end--;
    if (end < patch.length) {
      const hunkBoundary = patch.lastIndexOf("\n@@ ", end - 1) + 1;
      const lineBoundary = patch.lastIndexOf("\n", end - 1) + 1;
      if (
        hunkBoundary > start &&
        Buffer.byteLength(patch.slice(start, hunkBoundary)) >=
          Buffer.byteLength(patch.slice(start, end)) / 2 &&
        (section.hunk.header !== null ||
          /^@@ /m.test(patch.slice(start, hunkBoundary)))
      )
        end = hunkBoundary;
      else if (lineBoundary > start) end = lineBoundary;
    }
    return end;
  }

  /**
   * Resolves requested current or uniquely matching prior paths into deduplicated
   * manifest indices, rejecting missing or ambiguous paths.
   */
  private selectFiles(paths: string[]) {
    return [
      ...new Set(
        paths.map((p) => {
          const current = this.files.findIndex((f) => f.path === p);
          if (current !== -1) return current;
          const matches = this.files.flatMap((f, i) =>
            f.previousPath === p ? [i] : [],
          );
          if (matches.length !== 1)
            throw new Error(
              "read_diff path is absent or ambiguous in this review manifest",
            );
          return matches[0];
        }),
      ),
    ];
  }

  /**
   * Restores a cursor issued by this prepared diff for the same ordered selection,
   * rejecting invalid cursors or batches. Starts at the first file when no cursor is
   * supplied.
   */
  private readPosition(cursor: string | null | undefined, selection: number[]) {
    let position: Position = { file: 0, offset: 0 };
    if (cursor) {
      const saved = this.cursors.get(cursor);
      if (
        !saved ||
        JSON.stringify(saved.selection) !== JSON.stringify(selection)
      )
        throw new Error("Invalid read_diff cursor or batch");
      position = { ...saved.position };
    }
    return position;
  }

  /**
   * Returns a bounded diff page with a selection-bound continuation cursor. Records
   * supplied offsets only after constructing an uncancelled response.
   */
  read(input: unknown) {
    this.signal?.throwIfAborted();
    this.recordRead();
    const args = readDiffArguments.parse(input);
    const selection = this.selectFiles(args.paths);
    let position = this.readPosition(args.cursor, selection);
    const sections: object[] = [];
    const updates: [number, number][] = [];
    /**
     * Builds the response wrapper around accumulated sections and the optional
     * continuation cursor.
     */
    const envelope = (cursor: string | null) => ({
      baselineSha: this.baselineSha,
      headSha: this.headSha,
      sections,
      cursor,
      remaining: cursor !== null,
    });
    /**
     * Checks the full serialized page against the output budget while reserving space
     * for a maximum-length cursor.
     */
    const fits = () =>
      Buffer.byteLength(JSON.stringify(envelope("0".repeat(64)))) <=
      this.outputBytes;
    while (position.file < selection.length) {
      const index = selection[position.file],
        file = this.files[index],
        patch = this.patches[index];
      if (file.content === "binary" || file.content === "unsupported") {
        sections.push({ file, state: file.content });
        if (!fits()) {
          sections.pop();
          break;
        }
        position = { file: position.file + 1, offset: 0 };
        continue;
      }
      const start = position.offset;
      const section = {
        file,
        state: "available",
        offsetBytes: Buffer.byteLength(patch.slice(0, start)),
        hunk: hunkPosition(patch, start),
        patch: "",
        complete: false,
      };
      sections.push(section);
      const end = this.patchEnd(patch, start, section, fits);
      if (end === start) {
        sections.pop();
        break;
      }
      section.patch = patch.slice(start, end);
      section.complete = end === patch.length;
      updates.push([index, end]);
      position = section.complete
        ? { file: position.file + 1, offset: 0 }
        : { file: position.file, offset: end };
      if (!section.complete) break;
    }
    if (!sections.length)
      throw new Error(
        "read_diff metadata exceeds response limit; request a smaller batch",
      );
    let cursor: string | null = null;
    if (position.file < selection.length) {
      cursor = createHash("sha256")
        .update(JSON.stringify([this.nonce, selection, position]))
        .digest("hex");
      this.cursors.set(cursor, { selection, position });
    }
    const result = JSON.stringify(envelope(cursor));
    this.signal?.throwIfAborted();
    for (const [index, end] of updates) this.markSupplied(index, end);
    this.recordRead(Buffer.byteLength(result));
    return result;
  }
}
