import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewResultSchema, type ReviewFinding } from "@razbor/contracts";
import { preparePublication } from "@razbor/database";
import {
  forgeMarkdown,
  forgejoSourceUrl,
  renderForgejoInline,
  renderForgejoReview,
} from "@razbor/forge-adapters";

const finding: ReviewFinding = {
  severity: "medium",
  path: "src/timer.ts",
  lineStart: 3,
  lineEnd: 4,
  title: "Stop the timer during shutdown",
  body: "The timer keeps running after shutdown.",
  failureScenario: "Closing a session leaves its periodic callback active.",
  suggestion: "Clear the timer during cleanup.",
};

const head = "b".repeat(40);

const diff =
  "diff --git a/src/timer.ts b/src/timer.ts\n--- a/src/timer.ts\n+++ b/src/timer.ts\n@@ -2,1 +2,3 @@\n context\n+timer\n+cleanup\n";

test("clean reviews contain only congratulations; findings retain counts, locations and expandable evidence", () => {
  const zero = renderForgejoReview(
    {
      prSummary: {
        title: "Improve session lifecycle",
        description: "Update session timers and shutdown handling.",
        labels: ["enhancement", "refactor"],
        diagram: 'flowchart TD\n  Session["Session"] --> Timer["Timer"]',
      },
      summary: "Everything is secure",
      findings: [],
    },
    head,
    { author: "username", limitations: ["Publication note"] },
  );
  assert.equal(
    zero,
    "🎉 Congratulations @username ! No actionable findings in the reviewed changes. Looks good to merge once your required checks and approvals pass.",
  );
  for (const findings of [
    [finding],
    [
      finding,
      { ...finding, severity: "high" as const, title: "Close the socket" },
    ],
  ]) {
    const body = renderForgejoReview(
      {
        prSummary: {
          title: "Improve session lifecycle",
          description: "Update session timers and shutdown handling.",
          labels: ["enhancement", "refactor"],
          diagram: 'flowchart TD\n  Session["Session"] --> Timer["Timer"]',
        },
        summary: "Lifecycle changes need cleanup.",
        findings,
      },
      head,
      {
        repositoryUrl: "https://forge.example/team/project",
        anchoredFindings: findings,
      },
    );
    const visible = body.split("## Review Summary")[1].split("<details>")[0];
    assert.match(
      body,
      /## PR Summary\n[\s\S]*Update session timers and shutdown handling\.\n\n<details>\n<summary>Diagram<\/summary>\n\n```mermaid\nflowchart TD[\s\S]*\n---\n\n## Review Summary\n/,
    );
    assert.ok(visible.includes(head));
    assert.ok(visible.includes(`${findings.length} finding`));
    assert.match(visible, /🟡 Medium \(1\)/);
    assert.match(body, /Stop the timer during shutdown/);
    assert.match(body, /src\/timer/);
    assert.match(body, /\/src\/commit\/[^>]*#L3-L4/);
    assert.match(
      body,
      /<summary>1\. Stop the timer during shutdown <code>🟡 Medium<\/code><\/summary>/,
    );
    assert.ok(body.includes(finding.failureScenario));
    assert.ok(!body.includes(finding.suggestion));
  }
  assert.doesNotMatch(
    renderForgejoReview({ summary: "Review", findings: [finding] }, head, {
      details: false,
    }),
    /<details>/,
  );
});

test("inline comments retain one visible fix and a local agent prompt without URLs or legacy native suggestions", () => {
  const prose = renderForgejoInline({
    ...finding,
    body: `${finding.body} See [timer lifecycle](https://docs.example/timers).`,
    failureScenario: `${finding.failureScenario} See https://docs.example/shutdown.`,
  });
  assert.match(prose, /^\*\*Medium · Stop the timer/);
  assert.ok(prose.includes(finding.failureScenario));
  assert.ok(prose.includes(finding.suggestion));
  assert.doesNotMatch(
    prose.split("<details>")[0],
    /Scenario:|Proposed fix:|^#/m,
  );
  const prosePrompt = prose.split("<summary>Prompt your agent</summary>")[1];
  assert.match(
    prosePrompt,
    /Inspect the local source in src\/timer\\?\.ts at lines 3-4/,
  );
  assert.match(prosePrompt, /timer lifecycle/);
  assert.match(prosePrompt, /smallest concrete fix|relevant existing checks/);
  assert.doesNotMatch(prosePrompt, /https?:\/\/|\]\(/);
  const code =
    '  clearTimeout(timer);\n  const fence = `three ``` ticks`;\n  const endpoint = "https://api.example/action";\n';
  const body = renderForgejoInline({
    ...finding,
    replacement: { startLine: 3, endLine: 4, code },
  });
  assert.ok(body.includes(code));
  assert.match(body, /````typescript/);
  assert.ok(!body.split("<details>")[0].includes(finding.suggestion));
  const codePrompt = body.split("<summary>Prompt your agent</summary>")[1];
  assert.ok(codePrompt.includes(finding.suggestion));
  assert.match(codePrompt, /````typescript/);
  assert.match(codePrompt, /const endpoint = "\[URL omitted\]";/);
  assert.doesNotMatch(codePrompt, /https?:\/\//);
  const legacy = renderForgejoInline({
    ...finding,
    suggestion: "```suggestion\nunsafe()\n```",
  });
  assert.match(legacy, /```typescript/);
  assert.doesNotMatch(legacy, /```suggestion/);
  assert.ok(
    renderForgejoInline({ ...finding, suggestion: "x".repeat(7000) }).includes(
      "x".repeat(7000),
    ),
  );
});

test("unvalidated replacement ranges degrade to advice, invalid anchors remain in recap", () => {
  for (const replacement of [
    { startLine: 3, endLine: 4, code: "clearTimeout(timer);" },
    { startLine: 3, endLine: 4, code: "clearTimeout(timer);\nclose();" },
  ]) {
    const prepared = preparePublication(
      { summary: "Review", findings: [{ ...finding, replacement }] },
      diff,
      "rev_abcdefghijklmnop",
    );
    assert.match(prepared.comments[0].body, /```typescript/);
    assert.equal(prepared.limitations.length, 0);
  }
  const prepared = preparePublication(
    {
      summary: "Review",
      findings: [
        {
          ...finding,
          replacement: { startLine: 2, endLine: 3, code: "unsafe()" },
        },
      ],
    },
    diff,
    "rev_abcdefghijklmnop",
  );
  assert.ok(prepared.comments[0].body.includes(finding.suggestion));
  assert.ok(!prepared.comments[0].body.includes("unsafe()"));
  assert.equal(prepared.limitations.length, 1);
  const unanchored = preparePublication(
    {
      summary: "Review",
      findings: [{ ...finding, lineStart: 99, lineEnd: 99 }],
    },
    diff,
    "rev_abcdefghijklmnop",
  );
  assert.equal(unanchored.comments.length, 0);
  assert.equal(unanchored.findings.length, 1);
  assert.ok(
    renderForgejoReview(
      { summary: "Review", findings: unanchored.findings },
      head,
    ).includes(finding.title),
  );
});

test("forge Markdown isolates HTML, unsafe destinations, image loads and interpolation", () => {
  const unsafe =
    "</details><script>alert(1)</script>\n\n![remote](https://bad.example/pixel)\n\n[unsafe](javascript:alert)\n\n```suggestion\nwrong()";
  const safe = forgeMarkdown(unsafe, finding.path);
  assert.doesNotMatch(
    safe,
    /<script>|<\/details>|!\[|javascript:|```suggestion/,
  );
  const result = renderForgejoReview(
    {
      summary: unsafe,
      findings: [
        { ...finding, title: "x**\n</summary> @person", path: "a`*<file>.ts" },
      ],
    },
    head,
  );
  assert.equal((result.match(/<details>/g) ?? []).length, 1);
  assert.equal((result.match(/<\/details>/g) ?? []).length, 1);
  assert.doesNotMatch(result, /@person/);
  for (const repository of [
    "javascript:alert(1)",
    "http://localhost:3000/repo",
    "http://127.0.0.1/repo",
  ])
    assert.equal(forgejoSourceUrl(repository, head, finding), undefined);
  assert.equal(
    forgejoSourceUrl("https://forge.example/team/project", head, {
      ...finding,
      path: "../x",
    }),
    undefined,
  );
});

test("saved results remain readable and malformed replacements retain strict validation", () => {
  const legacy = { summary: "Review", findings: [finding] };
  assert.deepEqual(reviewResultSchema.parse(legacy), legacy);
  assert.equal(
    reviewResultSchema.parse({
      summary: "Review",
      findings: [{ ...finding, replacement: null }],
    }).findings[0].replacement,
    null,
  );
  for (const replacement of [
    { startLine: 4, endLine: 3, code: "x" },
    { startLine: 0, endLine: 1, code: "x" },
    { startLine: 3, endLine: 3, code: 1 },
  ])
    assert.equal(
      reviewResultSchema.safeParse({
        summary: "Review",
        findings: [{ ...finding, replacement }],
      }).success,
      false,
    );
});
