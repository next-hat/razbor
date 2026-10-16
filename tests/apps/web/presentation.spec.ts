import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewMarkdown } from "@razbor/web/review-markdown";
import { ReviewResult } from "@razbor/web/review-result";
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
