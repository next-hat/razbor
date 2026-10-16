import type { ReviewFinding, ReviewJobView } from "@contracts/src/index.js";

/**
 * Names a reviewed revision with its captured forge title and a 12-character commit
 * prefix. API and legacy reviews fall back to the generated title or a neutral label.
 */
export function reviewDisplayName(
  review: Pick<ReviewJobView, "changeTitle" | "headSha" | "review">,
) {
  const title =
    review.changeTitle?.trim() ||
    review.review?.prSummary?.title.trim() ||
    "Code review";
  const commit = review.headSha?.slice(0, 12);
  return commit ? `${title} · ${commit}` : title;
}

const aliases: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  rust: "rust",
  py: "python",
  python: "python",
  go: "go",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
  html: "html",
  css: "css",
  text: "text",
  txt: "text",
  plaintext: "text",
};

/**
 * Resolve supported syntax aliases, falling back to plain text for unknown
 * labels.
 */
function normalizeLanguage(label: string) {
  return Object.hasOwn(aliases, label) ? aliases[label] : "text";
}

/**
 * Choose a supported syntax language from the filename, including Dockerfile
 * variants.
 */
export function fileLanguage(path: string): string {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^(?:dockerfile(?:\..+)?|.+\.dockerfile)$/.test(name))
    return "dockerfile";
  return normalizeLanguage(name.includes(".") ? name.split(".").at(-1)! : "");
}

/**
 * Resolve explicit code labels, deriving suggestion blocks and missing labels
 * from the file path.
 */
export function codeLanguage(language?: string | null, path = ""): string {
  const label = language?.trim().toLowerCase();
  if (!label || /^suggestion(?::.*)?$/.test(label)) return fileLanguage(path);
  return normalizeLanguage(label);
}

/** Wrap code or Mermaid source in a fence longer than any embedded backtick run. */
export function codeFence(code: string, language: string): string {
  const runs = code.match(/`+/g) ?? [];
  const fence = "`".repeat(
    runs.reduce((length, run) => Math.max(length, run.length + 1), 3),
  );
  const label = language === "mermaid" ? "mermaid" : codeLanguage(language);
  return `${fence}${label}\n${code}\n${fence}`;
}

export const severityOrder = ["critical", "high", "medium", "low"] as const;

/** Capitalize a severity for display without changing its ordering key. */
export function severityLabel(value: ReviewFinding["severity"]) {
  return value[0].toUpperCase() + value.slice(1);
}

/**
 * Return counts for every severity in display order, including empty
 * categories.
 */
export function findingCounts(findings: ReviewFinding[]) {
  return severityOrder.map((severity) => ({
    severity,
    count: findings.filter((f) => f.severity === severity).length,
  }));
}

// Only explicit web destinations become links. Repository paths are plain text.
/**
 * Normalize an explicit HTTP(S) destination, rejecting credentials, control
 * characters and invalid URLs.
 */
export function safeReviewUrl(value: string): string | undefined {
  if (
    !/^https?:\/\//i.test(value) ||
    [...value].some((c) => c.codePointAt(0)! <= 32 || c.codePointAt(0)! === 127)
  )
    return;
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}
