import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { mergePolicySchema, type MergeDecisionStatus } from "@razbor/contracts";
import type { PullRequestView } from "@razbor/database";
import { TriageQueue } from "@razbor/web/triage-queue";
import { RepositoryMergePolicy } from "@razbor/web/repository-merge-policy";
import { triageQueue, initialQueueFilters } from "@razbor/web/merge-triage";
import { visiblePullRequest } from "@razbor/web/pull-requests";
import { IndexPanel, type IndexData } from "@razbor/web/index-panel";
import { ReviewMarkdown } from "@razbor/web/review-markdown";
import { ReviewResult } from "@razbor/web/review-result";
import { ReviewLog } from "@razbor/web/review-log";
import { highlightCode } from "@razbor/web/highlight";

test("disabled Codebase Memory hides index actions and keeps token creation unavailable", () => {
  const project: IndexData["projects"][number] = {
    id: null,
    repositoryId: "repo_fixture",
    name: "owner/repository",
    configKey: "fixture",
    state: "disabled",
    headSha: null,
    indexedAt: null,
    kind: "persistent",
    canCreateToken: false,
    preparation: {
      state: "error",
      phase: "error",
      startedAt: "2026-10-20T09:59:00Z",
      updatedAt: "2026-10-20T10:00:00Z",
      code: { processed: 0 },
      documents: { processed: 0 },
    },
  };
  const html = renderToStaticMarkup(
    createElement(IndexPanel, {
      repositoryId: project.repositoryId,
      initialData: {
        asOf: "2026-10-20T10:00:00Z",
        preparationAvailable: true,
        projects: [project],
        repositories: [project],
        tokens: [],
      },
    }),
  );
  assert.match(html, />Disabled</);
  assert.doesNotMatch(
    html,
    />Index repository<|>Refresh index<|>Indexing failed</,
  );
  assert.match(
    html,
    /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Generate token<\/button>/s,
  );
});

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

/** Build saved PR display data with deliberately inverted dates to distinguish priority order from recency. */
function triagePr(
  number: number,
  status: MergeDecisionStatus,
  confidence?: number,
): PullRequestView {
  const stamp = new Date(Date.UTC(2026, 0, number)).toISOString();
  return {
    id: `pr_${number}`,
    repositoryId: number % 2 ? "repo_first" : "repo_second",
    repositoryName: number % 2 ? "org/first" : "org/second",
    number,
    title: `Change title ${number}`,
    url: `https://example.com/pr/${number}`,
    state: "open",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    createdAt: stamp,
    updatedAt: stamp,
    syncedAt: stamp,
    reviewCount: 1,
    continuousReviewActive: false,
    merge: {
      decision: { status, reviewers: [], reasons: [] },
      ...(confidence === undefined ? {} : { confidence, riskLevel: "medium" }),
    },
  };
}

test("only repository managers see configured reviewer candidates on PRs and their reviews", () => {
  const pr = triagePr(1, "human_review_required");
  const decision = {
    status: "human_review_required" as const,
    reviewers: ["unverified-candidate"],
    reasons: [],
  };
  const review = {
    id: "review_1",
    repositoryId: pr.repositoryId,
    status: "completed" as const,
    submittedAt: pr.createdAt,
    mergeDecision: decision,
  };
  const detail = {
    ...pr,
    merge: { decision },
    latestReview: review,
    reviews: [review],
  };
  const member = visiblePullRequest(detail, false);
  const manager = visiblePullRequest(detail, true);
  for (const [view, expected] of [
    [member, []],
    [manager, ["unverified-candidate"]],
  ] as const) {
    assert.deepEqual(view.merge.decision.reviewers, expected);
    assert.deepEqual(view.latestReview.mergeDecision.reviewers, expected);
    assert.deepEqual(view.reviews[0].mergeDecision.reviewers, expected);
  }
});

test("both queue surfaces put human escalation before intervention, verification, running reviews and eligibility", () => {
  const rows = [
    triagePr(5, "auto_merge_eligible", 99),
    triagePr(4, "review_in_progress"),
    triagePr(3, "awaiting_checks"),
    triagePr(2, "blocked", 88),
    triagePr(1, "human_review_required", 60),
  ];
  for (const global of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(TriageQueue, { pullRequests: rows, global }),
    );
    const order = rows.map((pr) => html.indexOf(pr.title));
    assert.ok(
      order.every(
        (position, index) =>
          position !== -1 && (index === 0 || position < order[index - 1]),
      ),
    );
    assert.match(html, /Needs human review/);
  }
  const unresolved = triagePr(6, "blocked");
  unresolved.merge!.action = "scheduled";
  const pendingSchedule = triagePr(7, "awaiting_checks");
  pendingSchedule.merge!.action = "scheduled";
  const scheduled = renderToStaticMarkup(
    createElement(TriageQueue, { pullRequests: [unresolved, pendingSchedule] }),
  );
  assert.match(scheduled, /Merge scheduled · Blocked/);
  assert.match(scheduled, /Merge scheduled · Awaiting checks/);
  unresolved.merge!.decision.reasons = [
    {
      code: "unresolved_provider_merge",
      message: "Check the outstanding request in the provider.",
    },
  ];
  for (const global of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(TriageQueue, {
        pullRequests: [rows[2], unresolved],
        global,
      }),
    );
    assert.match(html, /Merge reconciliation required/);
    assert.ok(html.indexOf(unresolved.title) < html.indexOf(rows[2].title));
    assert.doesNotMatch(
      html,
      /Confidence \d+\/100|Earlier decision<\/span>|Merge scheduled<\/span>/,
    );
  }
  const pending = triagePr(6, "stale");
  const filtered = triageQueue([...rows, pending], {
    ...initialQueueFilters,
    repository: "repo_first",
    confidence: "95",
    risk: "medium",
  });
  assert.deepEqual(
    filtered.map((pr) => pr.number),
    [1],
  );
  assert.deepEqual(
    triageQueue(rows, { ...initialQueueFilters, order: "updated" }).map(
      (pr) => pr.number,
    ),
    [5, 4, 3, 2, 1],
  );
  assert.deepEqual(
    triageQueue(rows, {
      ...initialQueueFilters,
      decision: "auto_merge_eligible",
    }).map((pr) => pr.number),
    [5],
  );
});

test("file-managed Merge Policy shows its version and guidance with no editable controls", () => {
  const html = renderToStaticMarkup(
    createElement(RepositoryMergePolicy, {
      repositoryId: "repo_fixture",
      editable: false,
      initial: {
        version: 4,
        policy: mergePolicySchema.parse({
          policyMarkdown: "## Review migrations",
          humanReviewers: [
            { username: "alice", responsibilities: "Authentication" },
          ],
        }),
      },
    }),
  );
  assert.match(
    html,
    /Only pull requests targeting the default branch can be auto-merged/,
  );
  assert.doesNotMatch(html, /Restrict the destination to the default branch/);
  assert.match(html, /Version 4/);
  assert.match(html, /Managed in the repository registry file/);
  assert.match(html, /Review migrations/);
  assert.match(html, /Authentication/);
  assert.doesNotMatch(html, /Save merge policy|Remove reviewer/);
  assert.match(html, /<textarea[^>]*disabled/);
});

test("managed settings explain the fixed destination while allowing edits to supported merge controls", () => {
  const html = renderToStaticMarkup(
    createElement(RepositoryMergePolicy, {
      repositoryId: "repo_fixture",
      editable: true,
      initial: {
        version: 1,
        policy: mergePolicySchema.parse({ defaultBranchOnly: false }),
      },
    }),
  );
  assert.match(html, /Enable merge automation/);
  assert.match(html, /Dry run · post confidence and reasons/);
  assert.match(html, /Automatically approve eligible revisions on the forge/);
  assert.match(html, /submit a real approval in dry run or live mode/);
  assert.match(html, /Save merge policy/);
  assert.match(
    html,
    /Only pull requests targeting the default branch can be auto-merged/,
  );
  assert.doesNotMatch(html, /Restrict the destination|defaultBranchOnly/);
});
