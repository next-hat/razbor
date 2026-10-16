import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { embeddingInputBytes } from "@indexer/src/embeddings.js";

export type CodeSymbol = {
  qualifiedName: string;
  path: string;
  startLine: number;
  endLine: number;
};

export type SemanticChunk = CodeSymbol & {
  content: string;
  text: string;
  contentHash: string;
  partial: boolean;
};

const chunkingVersion = "razbor-semantic-chunks-v1";

const maxFileBytes = 1_000_000;

export const maxSourceBytes = 100_000_000;

const contextValueBytes = 180;

/** Move a byte limit back to a UTF-8 code-point boundary before slicing a fragment. */
function utf8Boundary(bytes: Uint8Array, limit: number) {
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/**
 * JSON-escape context metadata within a byte budget, retaining whole characters and
 * reserving room for a truncation marker.
 */
export function contextValue(value: string, limit = contextValueBytes) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= limit) return encoded;
  let clipped = "";
  let bytes = 5; // The enclosing quotes and trailing ellipsis are part of the budget.
  for (const character of value) {
    const escaped = JSON.stringify(character).slice(1, -1);
    const size = Buffer.byteLength(escaped);
    if (bytes + size > limit) break;
    clipped += escaped;
    bytes += size;
  }
  return `"${clipped}..."`;
}

/**
 * Normalize a source path relative to the repository and reject empty, NUL-containing, or
 * escaping paths.
 */
export function relativeSourcePath(repository: string, sourcePath: string) {
  if (
    typeof sourcePath !== "string" ||
    !sourcePath ||
    sourcePath.includes("\0")
  )
    throw new Error("invalid semantic source path");
  const absolute = path.resolve(repository, sourcePath);
  const relative = path.relative(repository, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("semantic source path escapes the repository");
  return relative;
}

/**
 * Validate each path component without following symlinks, requiring a bounded regular file
 * at a canonical path.
 */
async function sourceFilePath(repository: string, relative: string) {
  let current = repository;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error("semantic source symlinks are not supported");
    if (index === segments.length - 1) {
      if (!info.isFile() || info.size > maxFileBytes)
        throw new Error("semantic source is not a bounded regular file");
    } else if (!info.isDirectory()) {
      throw new Error("semantic source parent is not a directory");
    }
  }
  const absolute = path.join(repository, relative);
  if ((await realpath(absolute)) !== absolute)
    throw new Error("semantic source path is not canonical");
  return absolute;
}

/**
 * Read a cancellable, bounded UTF-8 source file without following its final symlink, and
 * return content with source-line offsets.
 */
export async function readSource(
  repository: string,
  relative: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  try {
    const absolute = await sourceFilePath(repository, relative);
    const file = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile())
        throw new Error("semantic source is not a regular file");
      if (info.size > maxFileBytes)
        throw new Error("semantic source file exceeds the byte limit");
      const bytes = Buffer.alloc(maxFileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
        const result = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maxFileBytes)
        throw new Error("semantic source file exceeds the byte limit");
      const source = bytes.subarray(0, length);
      if (source.includes(0))
        throw new Error("binary semantic sources are not supported");
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(source);
      const starts = [0];
      for (
        let at = content.indexOf("\n");
        at !== -1;
        at = content.indexOf("\n", at + 1)
      )
        if (at + 1 < content.length) starts.push(at + 1);
      return { content, starts, bytes: length };
    } finally {
      await file.close();
    }
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "semantic source cannot be read as a bounded regular UTF-8 file",
    );
  }
}

/**
 * Yield byte-bounded source spans with original line numbers, preserving whole lines where
 * possible and splitting long lines at UTF-8 boundaries.
 */
export function* sourceFragments(
  content: string,
  startLine: number,
  budget: number,
) {
  let pending = "";
  let pendingBytes = 0;
  let pendingStart = startLine;
  let pendingEnd = startLine;
  let lineNumber = startLine;
  let position = 0;
  while (position < content.length) {
    const newline = content.indexOf("\n", position);
    const end = newline === -1 ? content.length : newline + 1;
    const line = Buffer.from(content.slice(position, end));
    if (pending && pendingBytes + line.length > budget) {
      yield { content: pending, startLine: pendingStart, endLine: pendingEnd };
      pending = "";
      pendingBytes = 0;
    }
    let offset = 0;
    while (line.length - offset > budget) {
      const remaining = line.subarray(offset);
      const size = utf8Boundary(remaining, budget);
      yield {
        content: remaining.subarray(0, size).toString("utf8"),
        startLine: lineNumber,
        endLine: lineNumber,
      };
      offset += size;
    }
    if (!pending) pendingStart = lineNumber;
    pending += line.subarray(offset).toString("utf8");
    pendingBytes += line.length - offset;
    pendingEnd = lineNumber;
    position = end;
    lineNumber++;
  }
  if (pending)
    yield { content: pending, startLine: pendingStart, endLine: pendingEnd };
}

/** Reject missing symbol identities and invalid or reversed source-line ranges. */
function validateSymbol(symbol: CodeSymbol) {
  if (
    typeof symbol.qualifiedName !== "string" ||
    !symbol.qualifiedName ||
    symbol.qualifiedName.includes("\0") ||
    !Number.isSafeInteger(symbol.startLine) ||
    !Number.isSafeInteger(symbol.endLine) ||
    symbol.startLine < 1 ||
    symbol.endLine < symbol.startLine
  )
    throw new Error("invalid semantic symbol or source range");
}

/**
 * Extract a validated symbol range and reserve embedding space for bounded path and symbol
 * context.
 */
function symbolContent(
  symbol: CodeSymbol,
  relative: string,
  source: Awaited<ReturnType<typeof readSource>>,
) {
  if (!source.content || symbol.endLine > source.starts.length)
    throw new Error("semantic symbol range is outside its source file");
  const content = source.content.slice(
    source.starts[symbol.startLine - 1]!,
    source.starts[symbol.endLine] ?? source.content.length,
  );
  const relativePath = relative.split(path.sep).join("/");
  const projectEnd = symbol.qualifiedName.indexOf(".");
  const localName =
    projectEnd === -1
      ? symbol.qualifiedName
      : symbol.qualifiedName.slice(projectEnd + 1);
  const prefix = `Path: ${contextValue(relativePath)}\nSymbol: ${contextValue(localName)}\n`;
  const budget = embeddingInputBytes - Buffer.byteLength(prefix);
  if (budget < 1000) throw new Error("semantic source budget is too small");
  const partial = Buffer.byteLength(content) > budget;
  return { content, relativePath, prefix, budget, partial };
}

/**
 * Generate hashed, revision-source fragments from discovered symbols while enforcing
 * canonical paths, source-byte limits, and a total chunk cap.
 */
export async function* chunkSymbols(
  repository: string,
  symbols: AsyncIterable<CodeSymbol>,
  maxChunks: number,
  signal: AbortSignal,
): AsyncGenerator<SemanticChunk> {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1)
    throw new Error("invalid semantic chunk limit");
  signal.throwIfAborted();
  let root: string;
  try {
    root = path.resolve(repository);
    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
      throw new Error("invalid semantic repository");
  } catch {
    signal.throwIfAborted();
    throw new Error("semantic repository must be a canonical directory");
  }
  let cachedPath: string | undefined;
  let cachedSource: Awaited<ReturnType<typeof readSource>> | undefined;
  let sourceBytes = 0;
  let chunks = 0;
  for await (const symbol of symbols) {
    signal.throwIfAborted();
    validateSymbol(symbol);
    const relative = relativeSourcePath(root, symbol.path);
    if (cachedPath !== relative) {
      cachedSource = await readSource(root, relative, signal);
      cachedPath = relative;
      sourceBytes += cachedSource.bytes;
      if (sourceBytes > maxSourceBytes)
        throw new Error("semantic source set exceeds the byte limit");
    }
    const { content, relativePath, prefix, budget, partial } = symbolContent(
      symbol,
      relative,
      cachedSource!,
    );
    for (const fragment of sourceFragments(content, symbol.startLine, budget)) {
      signal.throwIfAborted();
      if (++chunks > maxChunks)
        throw new Error("semantic index exceeds the chunk limit");
      const text = prefix + fragment.content;
      yield {
        qualifiedName: symbol.qualifiedName,
        path: relativePath,
        ...fragment,
        text,
        partial,
        contentHash: createHash("sha256")
          .update(`${chunkingVersion}\0`)
          .update(text)
          .digest("hex"),
      };
    }
  }
}
