import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { gitEnvironment, safeGitOptions } from "@razbor/harness/git";

import { documentEmbeddingInputBytes } from "@indexer/src/embeddings.js";
import {
  contextValue,
  maxSourceBytes,
  readSource,
  relativeSourcePath,
  sourceFragments,
  type SemanticChunk,
} from "@indexer/src/semantic-chunks.js";

export const documentChunkingVersion = "razbor-document-chunks-v2";

const exec = promisify(execFile);

const markdownPathspec = ":(icase,glob)**/*.md";

type Fence = { marker: string; length: number };

type DocumentSection = {
  lines: string[];
  startLine: number;
  heading: string;
};

/**
 * Run bounded Git enumeration with the fixed Markdown glob enabled, returning only valid
 * UTF-8 output and safe failure messages.
 */
async function documentGit(
  repository: string,
  args: string[],
  signal: AbortSignal,
) {
  try {
    const result = await exec(
      "git",
      [...safeGitOptions, "-C", repository, ...args],
      {
        // Only the fixed Markdown pathspec uses globbing; no caller input does.
        env: { ...gitEnvironment, GIT_LITERAL_PATHSPECS: "0" },
        timeout: 30_000,
        maxBuffer: 1_000_000,
        encoding: "buffer",
        signal,
      },
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    signal.throwIfAborted();
    throw new Error("bounded Markdown file enumeration failed");
  }
}

/**
 * Enumerate regular tracked Markdown files at the checkout root, honoring Git and .cbmignore
 * exclusions and rejecting unmerged or unsupported paths.
 */
async function trackedDocuments(repository: string, signal: AbortSignal) {
  if (
    (
      await documentGit(repository, ["rev-parse", "--show-prefix"], signal)
    ).trim()
  )
    throw new Error("document repository must be the Git checkout root");
  const exclusions = ["--exclude-standard"];
  const ignore = await lstat(path.join(repository, ".cbmignore")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (ignore) {
    await readSource(repository, ".cbmignore", signal);
    exclusions.push("--exclude-from=.cbmignore");
  }
  const ignored = new Set(
    (
      await documentGit(
        repository,
        [
          "ls-files",
          "--cached",
          "--ignored",
          "-z",
          ...exclusions,
          "--",
          markdownPathspec,
        ],
        signal,
      )
    ).split("\0"),
  );
  const entries = await documentGit(
    repository,
    ["ls-files", "--cached", "--stage", "-z", "--", markdownPathspec],
    signal,
  );
  const paths: string[] = [];
  for (const entry of entries.split("\0")) {
    if (!entry) continue;
    const match =
      /^([0-7]{6}) (?:[a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(
        entry,
      );
    if (match?.[2] !== "0")
      throw new Error(
        "document repository has invalid or unmerged Git entries",
      );
    const name = match[3]!;
    if (!["100644", "100755"].includes(match[1]!) || ignored.has(name))
      continue;
    if (name.includes("\\") || Buffer.byteLength(name) > 4096)
      throw new Error("unsupported tracked Markdown source path");
    paths.push(relativeSourcePath(repository, name));
  }
  return paths;
}

/**
 * Recognize Markdown backtick or tilde fence openings, excluding invalid backticks in the
 * info string.
 */
function openingFence(line: string): Fence | undefined {
  const value = line.trimEnd();
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(value);
  if (
    !match ||
    (match[1]!.startsWith("`") && value.slice(match[0].length).includes("`"))
  )
    return undefined;
  return { marker: match[1]![0]!, length: match[1]!.length };
}

/**
 * Recognize a fence terminator only when its marker matches and its length covers the
 * opening fence.
 */
function closingFence(line: string, fence: Fence) {
  const match = /^ {0,3}(`{3,}|~{3,})$/.exec(line.trimEnd());
  return (
    !!match &&
    match[1]!.startsWith(fence.marker) &&
    match[1]!.length >= fence.length
  );
}

type DocumentHeading = { level: number; title: string; start: number };

/**
 * Remove optional ATX closing markers using a linear scan that avoids backtracking on long
 * headings.
 */
function atxTitle(value: string) {
  // Scan the optional closing marker once, avoiding backtracking on long headings.
  let end = value.length;
  while (end > 0 && /[ \t]/.test(value[end - 1]!)) end--;
  const trimmed = value.slice(0, end);
  let marker = trimmed.length;
  while (marker > 0 && trimmed[marker - 1] === "#") marker--;
  if (
    marker < trimmed.length &&
    marker > 0 &&
    /[ \t]/.test(trimmed[marker - 1]!)
  )
    return trimmed.slice(0, marker).trim();
  return value.trim();
}

/**
 * Recognize ATX headings or a Setext underline for the current paragraph, preserving the
 * heading start line.
 */
function documentHeading(
  line: string,
  index: number,
  lines: string[],
  paragraphStart: number | undefined,
): DocumentHeading | undefined {
  const atx = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
  if (atx) {
    const content = line.slice(atx[0].length).replace(/^[ \t]+/, "");
    return { level: atx[1]!.length, title: atxTitle(content), start: index };
  }
  const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!setext || paragraphStart === undefined) return undefined;
  return {
    level: setext[1]!.startsWith("=") ? 1 : 2,
    title: lines
      .slice(paragraphStart, index)
      .map((value) => value.trim())
      .join(" "),
    start: paragraphStart,
  };
}

/**
 * Exclude indentation, list markers, block quotes, and thematic breaks from prospective
 * Setext heading paragraphs.
 */
function paragraphContinues(line: string) {
  if (line.startsWith("    ") || line.startsWith("\t")) return false;
  const value = line.replace(/^ {0,3}/, "");
  return (
    !/^(?:[-+*][ \t]|\d+[.)][ \t]|>)/.test(value) &&
    !/^[-*_]{3,}[ \t]*$/.test(value)
  );
}

/**
 * Locate the closing delimiter of initial YAML frontmatter, or return -1 when no complete
 * frontmatter block is present.
 */
function frontmatterEnd(lines: string[]) {
  if (!/^\uFEFF?---[ \t]*(?:\r?\n)?$/.test(lines[0] ?? "")) return -1;
  return lines.findIndex(
    (line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*(?:\r?\n)?$/.test(line),
  );
}

/**
 * Yield headings outside initial frontmatter and fenced code, tracking paragraph starts for
 * Setext headings.
 */
function* documentHeadings(lines: string[]): Generator<DocumentHeading> {
  let paragraphStart: number | undefined;
  let fence: Fence | undefined;
  const frontmatter = frontmatterEnd(lines);
  for (let index = frontmatter + 1; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r?\n$/, "").replace(/^\uFEFF/, "");
    if (fence) {
      if (closingFence(line, fence)) fence = undefined;
      continue;
    }
    fence = openingFence(line);
    if (fence) {
      paragraphStart = undefined;
      continue;
    }
    const heading = documentHeading(line, index, lines, paragraphStart);
    if (heading) {
      yield heading;
      paragraphStart = undefined;
    } else if (!line.trim()) paragraphStart = undefined;
    else if (paragraphStart === undefined && paragraphContinues(line))
      paragraphStart = index;
  }
}

/**
 * Partition document lines at headings while retaining each section’s hierarchy and original
 * line offset.
 */
function* documentSections(lines: string[]): Generator<DocumentSection> {
  const headings: { level: number; title: string }[] = [];
  let start = 0;
  /**
   * Render the active heading hierarchy, using Document for content before the first
   * heading.
   */
  const heading = () =>
    headings.map((item) => item.title).join(" > ") || "Document";
  for (const next of documentHeadings(lines)) {
    if (next.start > start)
      yield {
        lines: lines.slice(start, next.start),
        startLine: start + 1,
        heading: heading(),
      };
    while (headings.length && headings.at(-1)!.level >= next.level)
      headings.pop();
    headings.push({
      level: next.level,
      title: next.title || "Untitled section",
    });
    start = next.start;
  }
  if (start < lines.length)
    yield {
      lines: lines.slice(start),
      startLine: start + 1,
      heading: heading(),
    };
}

/** Group a section into prose and fenced-code blocks without splitting complete fences. */
function* documentBlocks(section: DocumentSection) {
  let start = 0;
  let fence: Fence | undefined;
  /**
   * Capture the pending block text and translate section-relative offsets into original
   * source lines.
   */
  const block = (end: number) => ({
    content: section.lines.slice(start, end).join(""),
    startLine: section.startLine + start,
    endLine: section.startLine + end - 1,
  });
  for (let index = 0; index < section.lines.length; index++) {
    const line = section.lines[index]!;
    if (fence) {
      if (closingFence(line, fence)) {
        yield block(index + 1);
        start = index + 1;
        fence = undefined;
      }
      continue;
    }
    fence = openingFence(line);
    if (
      index > start &&
      (fence || (line.trim() && !section.lines[index - 1]!.trim()))
    ) {
      yield block(index);
      start = index;
    }
  }
  if (start < section.lines.length) yield block(section.lines.length);
}

/**
 * Pack whole document blocks into the byte budget and mark fragments partial only when an
 * oversized block must be split.
 */
function* documentFragments(section: DocumentSection, budget: number) {
  let pending:
    { content: string; startLine: number; endLine: number } | undefined;
  for (const block of documentBlocks(section)) {
    const bytes = Buffer.byteLength(block.content);
    if (pending && Buffer.byteLength(pending.content) + bytes > budget) {
      yield { ...pending, partial: false };
      pending = undefined;
    }
    if (bytes > budget) {
      for (const fragment of sourceFragments(
        block.content,
        block.startLine,
        budget,
      ))
        yield { ...fragment, partial: true };
    } else if (pending) {
      pending.content += block.content;
      pending.endLine = block.endLine;
    } else pending = block;
  }
  if (pending) yield { ...pending, partial: false };
}

/**
 * Split a rejected passage into strictly smaller UTF-8 spans while retaining context and
 * recomputing hashes; fail when no further split can make progress.
 */
export function splitDocumentChunk(chunk: SemanticChunk): SemanticChunk[] {
  const failure =
    "document passage cannot be split within the model token limit";
  if (!chunk.content || !chunk.text.endsWith(chunk.content))
    throw new Error(failure);
  const contentBytes = Buffer.byteLength(chunk.content);
  let characterBytes = 0;
  for (const character of chunk.content)
    characterBytes = Math.max(characterBytes, Buffer.byteLength(character));
  // Even a short fragment must fit its largest code point to guarantee progress.
  const budget = Math.max(characterBytes, Math.floor(contentBytes / 2));
  if (budget >= contentBytes) throw new Error(failure);
  const prefix = chunk.text.slice(0, -chunk.content.length);
  const fragments = [
    ...sourceFragments(chunk.content, chunk.startLine, budget),
  ];
  if (
    fragments.length < 2 ||
    fragments.some(
      (fragment) => Buffer.byteLength(fragment.content) >= contentBytes,
    )
  )
    throw new Error(failure);
  return fragments.map((fragment) => {
    const text = prefix + fragment.content;
    return {
      ...chunk,
      ...fragment,
      text,
      partial: true,
      contentHash: createHash("sha256")
        .update(`${documentChunkingVersion}\0`)
        .update(text)
        .digest("hex"),
    };
  });
}

/**
 * Attach bounded heading/path context to nonblank section fragments and hash them with the
 * document chunker version.
 */
function* sectionChunks(
  section: DocumentSection,
  relativePath: string,
  signal: AbortSignal,
): Generator<SemanticChunk> {
  // Keep full bounded metadata, while reserving most model input for prose.
  const qualifiedName: string = JSON.parse(contextValue(section.heading, 4096));
  const prefix = `Path: ${contextValue(relativePath, 48)}\nHeading: ${contextValue(section.heading, 64)}\n`;
  const budget = documentEmbeddingInputBytes - Buffer.byteLength(prefix);
  if (budget < 300) throw new Error("document source budget is too small");
  for (const fragment of documentFragments(section, budget)) {
    signal.throwIfAborted();
    if (!fragment.content.trim()) continue;
    const text = prefix + fragment.content;
    yield {
      path: relativePath,
      qualifiedName,
      ...fragment,
      text,
      contentHash: createHash("sha256")
        .update(`${documentChunkingVersion}\0`)
        .update(text)
        .digest("hex"),
    };
  }
}

/**
 * Resolve the repository root and require a canonical directory before reading tracked
 * documents.
 */
async function documentRoot(repository: string) {
  const root = path.resolve(repository);
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new Error("document repository must be a canonical directory");
  return root;
}

/**
 * Yield bounded, hashed Markdown passages from approved tracked files, retaining heading and
 * line provenance while limiting total source bytes and chunks.
 */
export async function* chunkDocuments(
  repository: string,
  maxChunks: number,
  signal: AbortSignal,
): AsyncGenerator<SemanticChunk> {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1)
    throw new Error("invalid document chunk limit");
  signal.throwIfAborted();
  const root = await documentRoot(repository);
  let sourceBytes = 0;
  let chunks = 0;
  for (const relative of await trackedDocuments(root, signal)) {
    signal.throwIfAborted();
    const source = await readSource(root, relative, signal);
    sourceBytes += source.bytes;
    if (sourceBytes > maxSourceBytes)
      throw new Error("document source set exceeds the byte limit");
    if (!source.content.trim()) continue;
    const relativePath = relative.split(path.sep).join("/");
    const lines = source.starts.map((start, index) =>
      source.content.slice(
        start,
        source.starts[index + 1] ?? source.content.length,
      ),
    );
    for (const section of documentSections(lines)) {
      for (const chunk of sectionChunks(section, relativePath, signal)) {
        if (++chunks > maxChunks)
          throw new Error("document index exceeds the chunk limit");
        yield chunk;
      }
    }
  }
}
