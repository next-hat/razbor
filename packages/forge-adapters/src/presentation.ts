import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import type { Root, RootContent } from "mdast";

import type { ReviewFinding, ReviewResult } from "@razbor/contracts";
import {
  codeFence,
  codeLanguage,
  fileLanguage,
  findingCounts,
  safeReviewUrl,
  severityLabel,
} from "@razbor/contracts/presentation";

import type { ForgeType } from "@forge-adapters/src/types.js";

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

const changeLabels = {
  enhancement: "✨ Enhancement",
  bugfix: "🐛 Bug fix",
  refactor: "♻️ Refactor",
  tests: "🧪 Tests",
  documentation: "📝 Documentation",
  maintenance: "🔧 Maintenance",
};

const severityEmojis = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

/**
 * Accept safe explicit web links while excluding localhost destinations from
 * published review content.
 */
function publishedUrl(value: string) {
  const safe = safeReviewUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "[::1]" ||
    url.hostname.startsWith("127.")
  )
    return;
  return safe;
}

/**
 * Escape prose for Markdown and HTML display, neutralize mentions and collapse
 * whitespace.
 */
export function forgeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, String.raw`\$1`)
    .replaceAll("@", "＠")
    .replace(/\s+/g, " ");
}

/** Escape plain disclosure titles for HTML without introducing Markdown escapes. */
function disclosureText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "＠")
    .replace(/\s+/g, " ");
}

// Parse first: legacy suggestion fences are display-only, never executable fixes.
// Re-serialization also closes unclosed fences before application-owned markup.
/**
 * Parse and sanitize review Markdown before publication, removing raw HTML and
 * remote images while normalizing links, code fences and mentions.
 */
export function forgeMarkdown(value: string, path = "") {
  const tree = markdown.parse(value);
  /**
   * Recursively sanitize the Markdown tree in place, preserving image alt text
   * and using supported display-only code languages.
   */
  function clean(node: Root | RootContent): void {
    if (node.type === "code") {
      node.lang = codeLanguage(node.lang, path);
      node.meta = null;
    } else if (node.type === "text") {
      node.value = node.value.replaceAll("@", "＠");
    } else if (node.type === "link" || node.type === "definition") {
      node.url = publishedUrl(node.url) ?? "";
    }
    if ("children" in node) {
      // Raw HTML is discarded; images become alt text without remote loads.
      node.children = node.children
        .filter((child) => child.type !== "html")
        .map((child) => {
          if (child.type === "image" || child.type === "imageReference")
            return {
              type: "text",
              value: (child.alt ?? "").replaceAll("@", "＠"),
            };
          clean(child);
          return child;
        }) as typeof node.children;
    }
  }
  clean(tree);
  return markdown.stringify(tree).trim();
}

/** Remove URL tokens while retaining quotes and source punctuation around them. */
function withoutUrls(value: string) {
  return value.replace(
    /\b(?:[a-z][a-z0-9+.-]*:\\?\/\\?\/|mailto:(?=[^\s<>"'`\\()[\]{},;]+@)|tel:(?=\+?\d)|data:(?=(?:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=+-]+)*)?,)|javascript:(?=[^\s<>"'`\\()[\]{},;]+\()|urn:(?=[a-z0-9-]+:)|www\.)[^\s<>"'`\\()[\]{},;]+|\/\/(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[a-f0-9:]+\])(?::\d+)?(?:\/[^\s<>"'`\\()[\]{},;]*)?/gi,
    (url) => (url.startsWith("//") ? "//[URL omitted]" : "[URL omitted]"),
  );
}

/** Preserve useful Markdown labels while removing every link target from agent instructions. */
function agentPromptMarkdown(value: string, path: string) {
  const tree = markdown.parse(forgeMarkdown(value, path));
  /** Strip URL-bearing text and unwrap links without interpreting source code as Markdown. */
  function clean(node: Root | RootContent): void {
    if (
      node.type === "text" ||
      node.type === "code" ||
      node.type === "inlineCode"
    )
      node.value = withoutUrls(node.value);
    if ("children" in node) {
      node.children = (node.children as RootContent[]).flatMap<RootContent>(
        (child) => {
          clean(child);
          if (child.type === "definition") return [];
          if (child.type === "link" || child.type === "linkReference")
            return child.children;
          return [child];
        },
      ) as typeof node.children;
    }
  }
  clean(tree);
  return markdown.stringify(tree).trim();
}

/** Build a copyable Markdown block of local fix instructions from validated metadata. */
function renderAgentPrompt(finding: ReviewFinding) {
  const f = finding;
  const replacement = f.replacement
    ? `\n\nProposed replacement for lines ${f.replacement.startLine}-${f.replacement.endLine}:\n\n${codeFence(withoutUrls(f.replacement.code), fileLanguage(f.path))}\n\nAdapt this replacement to the local source and preserve existing values where placeholders appear.`
    : "";
  const prompt = `Inspect the local source in ${forgeText(f.path)} at lines ${lineRangeLabel(f)} and fix **${forgeText(f.title)}**.\n\nProblem:\n\n${agentPromptMarkdown(f.body, f.path)}\n\nFailure scenario:\n\n${agentPromptMarkdown(f.failureScenario, f.path)}\n\nFix guidance:\n\n${agentPromptMarkdown(f.suggestion, f.path)}${replacement}\n\nImplement the smallest concrete fix that addresses this scenario, following the repository's existing patterns. Run the relevant existing checks and report the change and validation results.`;
  return `<details>\n<summary>Prompt your agent</summary>\n\n${codeFence(withoutUrls(prompt), "text")}\n\n</details>`;
}

/**
 * Render a finding's location, prose, display-only fix and local agent-prompt disclosure.
 */
export function renderInline(finding: ReviewFinding) {
  const f = finding;
  // Publish display-only code consistently; never infer an executable patch
  // from Markdown. The visible range also survives providers using one anchor.
  const scenario =
    f.failureScenario.trim() === f.body.trim()
      ? ""
      : `\n\n${forgeMarkdown(f.failureScenario, f.path)}`;
  const fix = f.replacement
    ? codeFence(f.replacement.code, fileLanguage(f.path))
    : forgeMarkdown(f.suggestion, f.path);
  return `**${severityLabel(f.severity)} · ${forgeText(f.title)}**\n\n${forgeText(f.path)}:${lineRangeLabel(f)}\n\n${forgeMarkdown(f.body, f.path)}${scenario}\n\n${fix}\n\n${renderAgentPrompt(f)}`;
}

/** Display inclusive endpoints while retaining the compact single-line label. */
function lineRangeLabel(finding: Pick<ReviewFinding, "lineStart" | "lineEnd">) {
  return finding.lineStart === finding.lineEnd
    ? String(finding.lineEnd)
    : `${finding.lineStart}-${finding.lineEnd}`;
}

// Repository URLs come from verified provider metadata, never from model output.
/**
 * Build a commit-pinned source link from verified repository metadata and a
 * safe repository-relative finding path, returning undefined for invalid
 * inputs.
 */
export function forgeSourceUrl(
  repositoryUrl: string,
  headSha: string,
  finding: ReviewFinding,
  forge: ForgeType = "forgejo",
) {
  const safe = publishedUrl(repositoryUrl);
  if (!safe || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) return;
  const url = new URL(safe);
  if (url.search || url.hash) return;
  const parts = finding.path.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p.includes("\\") ||
        [...p].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0)! === 127),
    )
  )
    return;
  const route = { forgejo: "src/commit", github: "blob", gitlab: "-/blob" }[
    forge
  ];
  const anchor =
    finding.lineStart === finding.lineEnd
      ? `L${finding.lineEnd}`
      : `L${finding.lineStart}-${forge === "gitlab" ? "" : "L"}${finding.lineEnd}`;
  return `${url.href.replace(/\/$/, "")}/${route}/${headSha}/${parts.map(encodeURIComponent).join("/")}#${anchor}`;
}

/**
 * Render change and review summaries in one sanitized recap, with emoji labels,
 * visible descriptions, optional Mermaid diagrams, individual finding
 * disclosures, validated source links and publication notes.
 * Reviews with no new or outstanding findings render only congratulations.
 * Saved results without a change summary retain a review-only recap.
 */
export function renderReview(
  result: ReviewResult,
  headSha: string,
  options: {
    details?: boolean;
    forgeType?: ForgeType;
    limitations?: string[];
    repositoryUrl?: string;
    anchoredFindings?: { path: string; lineStart: number; lineEnd: number }[];
    author?: string;
    previousFindings?: {
      title: string;
      severity?: ReviewFinding["severity"];
      finding?: ReviewFinding;
      originalHead?: string;
      status: "open" | "uncertain";
    }[];
  } = {},
) {
  const outstanding = options.previousFindings ?? [];
  const count = result.findings.length + outstanding.length;
  if (count === 0) {
    const author =
      options.author && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.author)
        ? ` @${options.author} !`
        : "!";
    return `🎉 Congratulations${author} No actionable findings in the reviewed changes. Looks good to merge once your required checks and approvals pass.`;
  }
  const counts = findingCounts(result.findings)
    .map(
      (c) =>
        `\`${severityEmojis[c.severity]} ${severityLabel(c.severity)} (${c.count + outstanding.filter((f) => f.severity === c.severity).length})\``,
    )
    .join(" ");
  const change = result.prSummary;
  const changeType = options.forgeType === "gitlab" ? "MR" : "PR";
  const labels = change?.labels
    .map((label) => `\`${changeLabels[label]}\``)
    .join(" ");
  const description = change && forgeMarkdown(change.description);
  const diagram = change?.diagram && codeFence(change.diagram, "mermaid");
  const changeDiagram = diagram
    ? options.details === false
      ? `\n\n### Diagram\n\n${diagram}`
      : `\n\n<details>\n<summary>Diagram</summary>\n\n${diagram}\n\n</details>`
    : "";
  const changeSummary = change
    ? `## ${changeType} Summary\n\n${forgeText(change.title)}${labels ? `\n\n${labels}` : ""}\n\n${description}${changeDiagram}\n\n---\n\n`
    : "";
  const heading = `${changeSummary}## Review Summary\n\n${counts}\n\nReviewed commit: ${forgeText(headSha)}\n\n**${count} finding${count === 1 ? "" : "s"}**`;
  const previousList = outstanding
    .map((previous, index) => {
      const status =
        previous.status === "open" ? "Still open" : "Fix not confirmed";
      const finding = previous.finding;
      if (!finding) return `- **${forgeText(previous.title)}** — ${status}`;
      const label = `${severityEmojis[finding.severity]} ${severityLabel(finding.severity)}`;
      const original = previous.originalHead
        ? `\n\nOriginally reported at commit: ${forgeText(previous.originalHead)}`
        : "";
      const evidence = `**${status}**\n\n${forgeText(finding.path)}:${lineRangeLabel(finding)}${original}\n\n${forgeMarkdown(finding.body, finding.path)}\n\n${forgeMarkdown(finding.failureScenario, finding.path)}`;
      const number = result.findings.length + index + 1;
      return options.details === false
        ? `#### ${number}. ${forgeText(previous.title)} · ${label}\n\n${evidence}`
        : `<details>\n<summary>${number}. ${disclosureText(previous.title)} <code>${label}</code></summary>\n\n${evidence}\n\n</details>`;
    })
    .join("\n\n");
  const previous = outstanding.length
    ? `\n\n### Previous findings still requiring attention\n\n${previousList}`
    : "";
  const noteList = options.limitations
    ?.map((l) => `- ${forgeText(l)}`)
    .join("\n");
  const notes = options.limitations?.length
    ? `\n\nPublication notes:\n${noteList}`
    : "";
  if (!result.findings.length) {
    const summary = change ? `\n\n${forgeMarkdown(result.summary)}` : "";
    return `${heading}\n\n**⚠️ Action required**${summary}\n\nNo new actionable findings in the reviewed changes.${previous}${notes}`;
  }
  const details = result.findings
    .map((f, index) => {
      const location = `${forgeText(f.path)}:${lineRangeLabel(f)}`;
      const anchored = options.anchoredFindings?.some(
        (location) =>
          location.path === f.path &&
          location.lineStart === f.lineStart &&
          location.lineEnd === f.lineEnd,
      );
      const url =
        anchored &&
        options.repositoryUrl &&
        forgeSourceUrl(options.repositoryUrl, headSha, f, options.forgeType);
      const sourceLocation = url ? `[${location}](<${url}>)` : location;
      const label = `${severityEmojis[f.severity]} ${severityLabel(f.severity)}`;
      const evidence = `${sourceLocation}\n\n${forgeMarkdown(f.body, f.path)}\n\n${forgeMarkdown(f.failureScenario, f.path)}`;
      // Use plain headings when HTML disclosures are disabled by the caller.
      return options.details === false
        ? `### ${index + 1}. ${forgeText(f.title)} · ${label}\n\n${evidence}`
        : `<details>\n<summary>${index + 1}. ${disclosureText(f.title)} <code>${label}</code></summary>\n\n${evidence}\n\n</details>`;
    })
    .join("\n\n");
  return `${heading}\n\n**⚠️ Action required**\n\n${forgeMarkdown(result.summary)}\n\n${details}${previous}${notes}`;
}
