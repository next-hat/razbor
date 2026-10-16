import { createHash } from "node:crypto";

import type { ReviewFinding, ReviewResult } from "@razbor/contracts";
import { renderInline, type InlineComment } from "@razbor/forge-adapters";

/**
 * Recognize the shared first-line review command, excluding Markdown indentation.
 */
export function reviewCommand(body: string) {
  // Indentation is Markdown code; only allow an actual first-line command.
  return /^\/agentic_review(?=\s|$)/i.test(body);
}

/** Return the shared command shown in the console and provider comments. */
export function reviewCommandText() {
  return "/agentic_review";
}

/**
 * Extract a safe added-file path from a diff header, rejecting parent
 * traversal and control delimiters.
 */
function addedFilePath(header: string) {
  const file = header.slice(6);
  if (/^[^\0\r\n]+$/.test(file) && !file.split("/").includes("..")) return file;
  return undefined;
}

/** Record the current new-side line only when the diff marks it as added. */
function recordAddedLine(
  value: string,
  lines: Set<number> | undefined,
  line: number,
) {
  if (value.startsWith("+")) lines?.add(line);
}

/**
 * Collect added anchors and visible new-side ranges from each unified diff
 * hunk without allowing comments to span omitted source between hunks.
 */
function diffLocations(diff: string) {
  const files = new Map<string, Set<number>>();
  const hunks = new Map<string, [number, number][]>();
  let file: string | undefined;
  let line = 0;
  let remaining = 0;
  let range: [number, number] | undefined;
  for (const value of diff.split("\n")) {
    if (value.startsWith("diff --git ")) {
      file = undefined;
      remaining = 0;
      range = undefined;
    }
    if (value.startsWith("+++ b/")) {
      file = addedFilePath(value);
      if (file) {
        files.set(file, new Set());
        hunks.set(file, []);
      }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(value);
    if (hunk) {
      line = Number(hunk[1]);
      remaining = Number(hunk[2] ?? 1);
      range = [line, line - 1];
      if (remaining > 0 && file) hunks.get(file)?.push(range);
      continue;
    }
    if (!file || remaining <= 0) continue;
    if (value.startsWith("+") || value.startsWith(" ")) {
      recordAddedLine(value, files.get(file), line);
      if (range) range[1] = line;
      line++;
      remaining--;
    }
  }
  return { files, hunks };
}

/** Collect valid new-side added lines for publication and replacement checks. */
export function changedLines(diff: string) {
  return diffLocations(diff).files;
}

/**
 * Build normalized finding content used to collapse repeated explanations
 * within the same file.
 */
function rootCause(f: ReviewFinding) {
  // The agent is instructed to emit one finding per cause. Collapse repeated
  // explanations and fixes across locations as a deterministic safeguard.
  /**
   * Reduce prose to lowercase alphanumeric words for deterministic duplicate
   * detection.
   */
  const normalize = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return [
    [
      f.path,
      normalize(f.body),
      normalize(f.failureScenario),
      normalize(f.suggestion),
    ].join("\0"),
  ];
}

/** Derive the stable short content hash embedded in published finding markers. */
export function findingKey(finding: ReviewFinding) {
  return createHash("sha256")
    .update(rootCause(finding).join("\0"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Deduplicate findings and publish ranges within one visible new-side hunk
 * ending on an added line. Retain prose findings and report invalid comment
 * or replacement ranges as limitations.
 */
export function preparePublication(
  result: ReviewResult,
  diff: string,
  reviewId: string,
) {
  const { files: locations, hunks } = diffLocations(diff);
  const seen = new Set<string>();
  const comments: InlineComment[] = [];
  const limitations: string[] = [];
  const findings: ReviewFinding[] = [];
  /** Require both endpoints in one hunk and an added endpoint for fallback anchors. */
  const validRange = (f: ReviewFinding) =>
    f.lineStart <= f.lineEnd &&
    !!locations.get(f.path)?.has(f.lineEnd) &&
    !!hunks
      .get(f.path)
      ?.some(([start, end]) => start <= f.lineStart && f.lineEnd <= end);
  const candidates = [...result.findings].sort(
    (a, b) => Number(validRange(b)) - Number(validRange(a)),
  );
  for (const f of candidates) {
    const causes = rootCause(f);
    if (causes.some((c) => seen.has(c))) continue;
    causes.forEach((c) => seen.add(c));
    findings.push(f);
    if (!validRange(f)) {
      limitations.push(
        `${f.path}:${f.lineStart}-${f.lineEnd}: range is not within one recorded diff hunk ending on an added line`,
      );
      continue;
    }
    const key = findingKey(f);
    const replacement = f.replacement;
    // Existing publication anchors are added lines at the recorded head. Stay
    // conservative: every replacement line must be validated in that same diff.
    const range =
      replacement && replacement.endLine - replacement.startLine + 1;
    const validReplacement =
      replacement &&
      range &&
      replacement.startLine <= f.lineStart &&
      f.lineEnd <= replacement.endLine &&
      range <= (locations.get(f.path)?.size ?? 0) &&
      Array.from({ length: range }, (_, i) => replacement.startLine + i).every(
        (line) => locations.get(f.path)?.has(line),
      );
    if (replacement && !validReplacement)
      limitations.push(
        `${f.path}:${f.lineStart}-${f.lineEnd}: replacement range was not validated; published prose advice only`,
      );
    comments.push({
      path: f.path,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      body: `${renderInline({ ...f, replacement: validReplacement ? replacement : null })}\n\n<!-- razbor:${reviewId}:${key} -->`,
    });
  }
  return { comments, limitations, count: findings.length, findings };
}
