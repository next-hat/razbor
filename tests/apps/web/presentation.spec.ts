import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewMarkdown } from "@razbor/web/review-markdown";
import { ReviewResult } from "@razbor/web/review-result";
import { ReviewLog } from "@razbor/web/review-log";
import { highlightCode } from "@razbor/web/highlight";

/** Render review Markdown as static HTML with a repository path for language inference. */
function render(markdown: string, path = "a.ts") {
  return renderToStaticMarkup(
    createElement(ReviewMarkdown, { children: markdown, path }),
  );
}

test("review Markdown renders prose, GFM tables, lists and code safely", () => {
  const html = render(
    "# Heading\n\n**Strong** and *emphasis* and `inline`\n\n- item\n\n> quote\n\n| A | B |\n| - | - |\n| one | two |\n\n```ts\n  const x = 1;\n```",
  );
  for (const tag of [
    "h1",
    "strong",
    "em",
    "ul",
    "li",
    "blockquote",
    "table",
    "pre",
    "code",
  ])
    assert.ok(html.includes(`<${tag}`), tag);
  assert.ok(html.includes("typescript"));
  assert.ok(html.includes("  const x = 1;"));
  assert.ok(html.includes('aria-label="Copy code"'));
  const unsafe = render(
    "<script>alert(1)</script>\n\n![pixel](https://bad.example/pixel)\n\n[bad](javascript:alert)\n\n[good](https://example.com)",
  );
  assert.doesNotMatch(unsafe, /<script|<img|javascript:/);
  assert.match(unsafe, /rel="noopener noreferrer"/);
  assert.match(unsafe, /href="https:\/\/example.com\//);
  assert.match(render("```unknown\n<script>inert</script>\n```"), /Plain text/);
  assert.match(render("```\nlet value = 1\n```"), /typescript/);
  assert.match(render("```suggestion\nlet value = 1\n```"), /typescript/);
  assert.match(render("```diff\n-old\n+new\n```"), />diff</);
});

test("highlighting caches work, preserves exact code, supports both themes and unknown languages", async () => {
  const code = "  const value: string = `hello`;\n\n";
  const pending = highlightCode(code, "typescript");
  assert.equal(highlightCode(code, "ts"), pending);
  const tokens = await pending;
  assert.equal(
    tokens.map((line) => line.map((t) => t.content).join("")).join("\n"),
    code,
  );
  assert.ok(tokens.flat().some((token) => token.htmlStyle?.color));
  assert.ok(tokens.flat().some((token) => token.htmlStyle?.["--shiki-dark"]));
  const plain = await highlightCode("<script>inert</script>", "unknown");
  assert.equal(
    plain
      .flat()
      .map((t) => t.content)
      .join(""),
    "<script>inert</script>",
  );
});

test("saved reviews have visible findings and an application-owned collapsed disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(ReviewResult, {
      review: {
        summary: "**Cleanup** review",
        findings: [
          {
            severity: "medium",
            title: "Close timer",
            path: "a.ts",
            lineStart: 2,
            lineEnd: 4,
            body: "Timer survives.",
            failureScenario: "After shutdown.",
            suggestion: "Clear timer.",
          },
        ],
      },
    }),
  );
  assert.ok(html.indexOf("Close timer") < html.indexOf("<details"));
  assert.match(html, /<summary[^>]*>View more<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /<strong>Cleanup<\/strong>/);
  assert.match(html, /a\.ts:2-4/);
});

/** Renders one retained attempt's optional telemetry without starting a live connection. */
function renderAttemptMetrics(metrics: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(ReviewLog, {
      job: {
        id: "rev_fixture",
        repositoryId: "repo_fixture",
        status: "failed",
        submittedAt: "2026-10-20T10:00:00Z",
      },
      lines: [
        {
          sequence: 1,
          attemptId: "att_fixture",
          time: "2026-10-20T10:00:00Z",
          level: "error",
          stage: "result",
          message: "Review failed",
          turn: 1,
          ...metrics,
        },
      ],
      connection: "finished",
      available: true,
    }),
  );
}

test("attempt log exposes configured monetary estimates and measured cache categories only when present", () => {
  const measured = renderAttemptMetrics({
    inputTokens: 100,
    outputTokens: 20,
    uncachedInputTokens: 40,
    cachedInputTokens: 50,
    cacheWriteTokens: 10,
    estimatedCostUsd: 0.000275,
    costEstimateComplete: true,
  });
  assert.match(measured, /40<\/strong> uncached input tokens/);
  assert.match(measured, /50<\/strong> cached input tokens/);
  assert.match(measured, /10<\/strong> cache-write tokens/);
  assert.match(measured, /0.000275 USD/);
  assert.match(measured, /estimated cost/);
  const incomplete = renderAttemptMetrics({
    estimatedCostUsd: 0.01,
    costEstimateComplete: false,
  });
  assert.match(incomplete, /estimated cost · incomplete usage/);
  assert.match(incomplete, /Usage is incomplete/);
  const legacy = renderAttemptMetrics();
  assert.doesNotMatch(
    legacy,
    /USD|cost estimate|cached input tokens|cache-write tokens/,
  );
});

test("attempt log uses the latest cumulative usage snapshot even without a turn field", () => {
  const base = {
    attemptId: "att_fixture",
    time: "2026-10-20T10:00:00Z",
    level: "info" as const,
    stage: "model" as const,
    message: "progress",
  };
  const html = renderToStaticMarkup(
    createElement(ReviewLog, {
      job: {
        id: "rev_fixture",
        repositoryId: "repo_fixture",
        status: "failed",
        submittedAt: base.time,
      },
      connection: "finished",
      available: true,
      lines: [
        {
          ...base,
          sequence: 1,
          turn: 2,
          maxTurns: 10,
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 30,
          uncachedInputTokens: 70,
          toolCalls: 4,
          estimatedCostUsd: 0.001,
          costEstimateComplete: true,
        },
        {
          ...base,
          sequence: 501,
          modelTurns: 3,
          inputTokens: 250,
          outputTokens: 25,
          cachedInputTokens: 80,
          uncachedInputTokens: 170,
          toolCalls: 7,
          estimatedCostUsd: 0.0025,
          costEstimateComplete: false,
        },
      ],
    }),
  );
  for (const text of [
    "250</strong> reported input tokens",
    "25</strong> reported output tokens",
    "80</strong> cached input tokens",
    "170</strong> uncached input tokens",
    "7</strong> tool calls",
    "3</strong> / 10 turns",
    "0.002500 USD",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /estimated cost · incomplete usage/);
});
