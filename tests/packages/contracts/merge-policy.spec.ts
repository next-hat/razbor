import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateMergeDecision,
  matchPathOwners,
  mergeAssessmentSchema,
  mergePolicySchema,
  mergePolicySnapshotSchema,
  publicMergeAssessment,
  publicMergeDecision,
  renderMergeEscalation,
  reviewConversationSchema,
  reviewResultSchema,
  selectMergeReviewers,
  type MergeAssessment,
  type MergeDecisionInput,
  type MergePolicy,
  type ReviewResult,
} from "@razbor/contracts";

const policy = mergePolicySchema.parse({ enabled: true });

const assessment: MergeAssessment = {
  confidence: 90,
  riskLevel: "low",
  reviewComplete: true,
  requiresHumanReview: false,
  reasons: ["Inspected README.md and checked the corrected local link."],
  criticalAreas: [],
  verificationGaps: [],
  suggestedReviewers: [],
};

const result: ReviewResult = {
  summary: "Inspected a documentation correction.",
  findings: [],
  mergeAssessment: assessment,
};

const input: MergeDecisionInput = {
  snapshot: { version: 1, policy },
  currentPolicyVersion: 1,
  reviewStatus: "completed",
  result,
  outstandingFindings: 0,
  revisionCurrent: true,
  open: true,
  draft: false,
  defaultBranch: "main",
  baseBranch: "main",
  humanEscalated: false,
  provider: { guarded: true, checks: "passing", restrictions: "satisfied" },
};

/** Evaluate an independent repository policy using the same reviewed source. */
function decide(
  assessmentOverride: Partial<MergeAssessment>,
  policyOverride: Partial<MergePolicy> = {},
) {
  return evaluateMergeDecision({
    ...input,
    snapshot: { version: 1, policy: { ...policy, ...policyOverride } },
    result: {
      ...result,
      mergeAssessment: { ...assessment, ...assessmentOverride },
    },
  });
}

test("merge policy defaults are inert and repository thresholds use inclusive integer boundaries", () => {
  assert.deepEqual(mergePolicySchema.parse({}), {
    enabled: false,
    dryRun: true,
    autoApprove: false,
    minimumConfidence: 90,
    mergeMethod: "squash",
    requirePassingChecks: true,
    defaultBranchOnly: true,
    policyMarkdown: "",
    humanReviewers: [],
  });
  for (const threshold of [-1, 101, 85.3])
    assert.equal(
      mergePolicySchema.safeParse({ minimumConfidence: threshold }).success,
      false,
    );
  assert.equal(decide({ confidence: 89 }).status, "human_review_required");
  assert.equal(decide({ confidence: 90 }).status, "auto_merge_eligible");
  assert.equal(decide({ confidence: 91 }).status, "auto_merge_eligible");
  assert.equal(
    decide({ confidence: 91 }, { minimumConfidence: 95 }).status,
    "human_review_required",
  );
  assert.equal(
    decide({ confidence: 100 }, { enabled: false }).status,
    "blocked",
  );
  assert.equal(
    mergePolicySchema.safeParse({ policyMarkdown: "🛠".repeat(10000) }).success,
    false,
  );
  assert.equal(
    mergePolicySnapshotSchema.safeParse({
      version: 1,
      policy: { enabled: true },
    }).success,
    false,
  );
  const { autoApprove, ...legacy } = policy;
  assert.equal(autoApprove, false);
  assert.deepEqual(
    mergePolicySnapshotSchema.parse({ version: 2, policy: legacy }).policy,
    policy,
  );
  const optIn = mergePolicySchema.parse({ enabled: true, autoApprove: true });
  assert.equal(optIn.dryRun, true);
  assert.equal(
    mergePolicySnapshotSchema.parse({ version: 3, policy: optIn }).policy
      .autoApprove,
    true,
  );
  assert.equal(
    mergePolicySnapshotSchema.safeParse({
      version: 2,
      policy: { ...legacy, autoApprove: "true" },
    }).success,
    false,
  );
  assert.equal(
    mergePolicySchema.safeParse({ policyMarkdown: "a\uD800" }).success,
    false,
  );
  const snapshot = mergePolicySnapshotSchema.parse({
    version: 3,
    policy: { ...policy, policyMarkdown: "Require verified backups." },
  });
  assert.equal(
    mergePolicySnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))).policy
      .policyMarkdown,
    "Require verified backups.",
  );
});

test("a reply context excludes merge evidence before applying the conversation size limit", () => {
  const originalReview = {
    ...result,
    summary: "s".repeat(197_000),
    mergeAssessment: {
      ...assessment,
      reasons: Array(12).fill("r".repeat(800)),
    },
  };
  const context = {
    reviewId: "rev_1234567890abcdef",
    originalBase: "base",
    originalHead: "head",
    originalReview,
    title: "Change",
    target: {
      commentId: "1",
      reviewId: "2",
      path: "a.ts",
      lineStart: 1,
      lineEnd: 1,
    },
    history: [],
    reply: { id: "3", author: "owner", body: "Please clarify." },
  };
  assert.ok(JSON.stringify(context).length > 200_000);
  assert.deepEqual(reviewConversationSchema.parse(context).originalReview, {
    summary: originalReview.summary,
    findings: [],
  });
  assert.equal(
    reviewConversationSchema.safeParse({
      ...context,
      originalReview: { ...originalReview, summary: "s".repeat(200_000) },
    }).success,
    false,
  );
});

test("invalid, absent and contradictory model evidence cannot approve merging", () => {
  for (const invalid of [
    { confidence: 100.5 },
    { riskLevel: "minor" },
    { reasons: [] },
    { reviewComplete: null },
    { authorizeMerge: true },
  ]) {
    assert.equal(
      mergeAssessmentSchema.safeParse({ ...assessment, ...invalid }).success,
      false,
    );
  }
  for (const malformed of [{ confidence: 100.5 }, { riskLevel: "minor" }]) {
    const decision = evaluateMergeDecision({
      ...input,
      result: {
        ...result,
        mergeAssessment: { ...assessment, ...malformed } as MergeAssessment,
      },
    });
    assert.equal(decision.status, "human_review_required");
    assert.ok(
      decision.reasons.some((reason) => reason.code === "missing_assessment"),
    );
  }
  const legacy = reviewResultSchema.parse({
    summary: "Finished",
    findings: [],
  });
  assert.equal(
    evaluateMergeDecision({ ...input, result: legacy }).status,
    "human_review_required",
  );
  assert.equal(
    evaluateMergeDecision({ ...input, snapshot: null }).status,
    "human_review_required",
  );
  for (const override of [
    { reviewComplete: false },
    { requiresHumanReview: true },
    { verificationGaps: ["Database suite failed."] },
    { criticalAreas: ["Authentication"] },
    { riskLevel: "high" },
    { riskLevel: "critical" },
  ] satisfies Partial<MergeAssessment>[]) {
    assert.equal(
      decide({ ...override, confidence: 100 }).status,
      "human_review_required",
    );
  }
  const finding = {
    severity: "critical",
    path: "auth.ts",
    lineStart: 3,
    lineEnd: 3,
    title: "Login bypass",
    body: "The permission gate is bypassed.",
    failureScenario: "Anonymous caller reaches protected resource.",
    suggestion: "Restore the permission check.",
  } as const;
  assert.equal(
    evaluateMergeDecision({
      ...input,
      result: { ...result, findings: [finding] },
    }).status,
    "human_review_required",
  );
  for (const status of ["open", "uncertain"] as const) {
    assert.equal(
      evaluateMergeDecision({
        ...input,
        result: {
          ...result,
          findingChecks: [
            {
              id: "prior",
              status,
              evidence: "Rechecked at the recorded head.",
            },
          ],
        },
      }).status,
      "human_review_required",
    );
    assert.equal(
      evaluateMergeDecision({
        ...input,
        result: {
          ...result,
          findingChecks: [
            { id: "prior", status, evidence: "Open during review." },
          ],
        },
        outstandingFindingsAudited: true,
        outstandingFindings: 0,
      }).status,
      "auto_merge_eligible",
    );
  }
  assert.equal(
    evaluateMergeDecision({ ...input, outstandingFindings: 1 }).status,
    "human_review_required",
  );
  assert.equal(
    evaluateMergeDecision({ ...input, humanEscalated: true }).status,
    "human_review_required",
  );
});

test("current policy, reviewed revisions, provider restrictions and default destination are independent gates", () => {
  assert.equal(
    evaluateMergeDecision({ ...input, currentPolicyVersion: 2 }).status,
    "stale",
  );
  assert.equal(
    evaluateMergeDecision({ ...input, revisionCurrent: false }).status,
    "stale",
  );
  for (const override of [
    { open: false },
    { draft: true },
    { reviewStatus: "failed" },
    { defaultBranch: null },
    { baseBranch: "feature-x" },
  ] as const) {
    assert.equal(
      evaluateMergeDecision({ ...input, ...override }).status,
      "blocked",
    );
  }
  assert.equal(
    evaluateMergeDecision({
      ...input,
      baseBranch: "feature-y",
      snapshot: { version: 1, policy: { ...policy, defaultBranchOnly: false } },
    }).status,
    "blocked",
  );
  for (const reviewStatus of ["queued", "running"] as const)
    assert.equal(
      evaluateMergeDecision({ ...input, reviewStatus }).status,
      "review_in_progress",
    );
  for (const override of [
    { guarded: false },
    { checks: "failed" },
    { checks: "unknown" },
    { restrictions: "blocked" },
    { restrictions: "unknown" },
  ] as const) {
    assert.equal(
      evaluateMergeDecision({
        ...input,
        provider: { ...input.provider, ...override },
      }).status,
      "blocked",
    );
  }
  assert.equal(
    evaluateMergeDecision({
      ...input,
      provider: { ...input.provider, checks: "pending" },
    }).status,
    "awaiting_checks",
  );
  assert.equal(
    evaluateMergeDecision({
      ...input,
      provider: { ...input.provider, restrictions: "pending" },
      snapshot: {
        version: 1,
        policy: { ...policy, requirePassingChecks: false },
      },
    }).status,
    "awaiting_checks",
  );
  assert.equal(
    evaluateMergeDecision({
      ...input,
      provider: { ...input.provider, merged: true },
    }).status,
    "merged",
  );
});

test("member decisions replace stored native and triage messages and discard unknown reason codes", () => {
  const privateNote = "Private policy guidance from a prior review.";
  const stored = {
    status: "blocked" as const,
    reviewers: [],
    reasons: [
      { code: "merge_refused", message: privateNote },
      { code: "unresolved_provider_merge", message: privateNote },
      { code: "eligibility_check_unconfirmed", message: privateNote },
      { code: privateNote, message: privateNote },
    ],
  };
  const visible = publicMergeDecision(stored);
  assert.ok(!JSON.stringify(visible).includes(privateNote));
  assert.deepEqual(
    visible.reasons.map(({ code }) => code),
    [
      "merge_refused",
      "unresolved_provider_merge",
      "eligibility_check_unconfirmed",
    ],
  );
  assert.match(visible.reasons[0].message, /provider declined/);
  assert.match(visible.reasons[1].message, /requires reconciliation/);
  assert.match(visible.reasons[2].message, /no visible eligibility check/);
  const unknown = publicMergeDecision({
    ...stored,
    status: "stale",
    reasons: [{ code: privateNote, message: privateNote }],
  });
  assert.deepEqual(unknown.reasons, [
    {
      code: "decision_status",
      message: "The previous merge decision is out of date.",
    },
  ]);
  assert.equal(stored.reasons[0].message, privateNote);
});

test("dry-run comments explain the score and native approval independently of merge eligibility", () => {
  const privateNote = "Private reviewer instructions @private-team";
  const opts = {
    snapshot: {
      version: 1,
      policy: { ...policy, autoApprove: true, policyMarkdown: privateNote },
    },
    assessment: {
      ...assessment,
      reasons: [privateNote],
      suggestedReviewers: [privateNote],
    },
    headSha: "a".repeat(40),
    marker: "<!-- razbor:pr_example:escalation -->",
  };
  const eligible = evaluateMergeDecision(input);
  const eligibleBody = renderMergeEscalation({ ...opts, decision: eligible });
  assert.match(eligibleBody, /Dry-run assessment/);
  assert.match(eligibleBody, /Merge confidence: 90\/100/);
  assert.match(eligibleBody, /Required threshold: 90\/100/);
  assert.match(eligibleBody, /Risk: low/);
  assert.match(
    eligibleBody,
    /No actionable or outstanding review findings remain/,
  );
  assert.match(eligibleBody, /required provider checks passed/);
  assert.doesNotMatch(eligibleBody, /confirmed Razbor’s approval/);
  assert.ok(!eligibleBody.includes(privateNote));
  assert.ok(
    eligibleBody.includes(opts.headSha) && eligibleBody.endsWith(opts.marker),
  );
  const decision = {
    status: "awaiting_checks" as const,
    reasons: [{ code: "required_check_pending", message: privateNote }],
    reviewers: ["private-team"],
  };
  const approved = renderMergeEscalation({
    ...opts,
    decision,
    approval: "approved",
  });
  assert.match(approved, /confirmed Razbor’s approval/);
  assert.match(approved, /still needed on the reviewed commit/);
  assert.doesNotMatch(
    approved,
    /checks passed|meets the configured merge requirements|private-team|Private reviewer/,
  );
  for (const [approval, wording] of [
    ["uncertain", /not confirmed whether/],
    ["dismissed", /approval was dismissed/],
    ["unavailable", /could not approve/],
  ] as const)
    assert.match(
      renderMergeEscalation({ ...opts, decision, approval }),
      wording,
    );
});

test("reviewer selection, fallback, and comment reconciliation only mention bounded configured identities", () => {
  const humanReviewers = [
    {
      username: "alice",
      responsibilities: "Owns authentication",
      riskCategories: ["auth"],
      pathPatterns: ["src/auth/**"],
    },
    { username: "bob", responsibilities: "General reviewer" },
    { username: "chris", responsibilities: "Owns pipelines" },
    { username: "dana", responsibilities: "Owns the UI" },
  ];
  const saved = { ...policy, humanReviewers };
  const owners = matchPathOwners(saved, [
    "src/auth/.config",
    "src/auth/nested/module.ts",
  ]);
  assert.deepEqual(owners, ["alice"]);
  assert.deepEqual(
    matchPathOwners(saved, [
      "src/auth",
      "src/authentication/login.ts",
      "src/Auth/a.ts",
    ]),
    [],
  );
  const specialized = {
    ...policy,
    humanReviewers: [
      { username: "general", responsibilities: "Triage" },
      {
        username: "database",
        responsibilities: "Schema",
        pathPatterns: ["/db/**/*.sql"],
      },
      {
        username: "api",
        responsibilities: "Handlers",
        pathPatterns: ["./api/v?/handler.*"],
      },
      {
        username: "dotfiles",
        responsibilities: "Configuration",
        pathPatterns: ["**/.config"],
      },
    ],
  };
  assert.deepEqual(
    matchPathOwners(specialized, [
      "api/v1/handler.ts",
      "db/deep/change.sql",
      ".config",
    ]),
    ["database", "api", "dotfiles"],
  );
  assert.deepEqual(matchPathOwners(specialized, ["db/initial.sql"]), [
    "database",
  ]);
  assert.deepEqual(matchPathOwners(specialized, ["api/v🍏/handler.ts"]), [
    "api",
  ]);
  assert.deepEqual(
    matchPathOwners(specialized, [
      "db/../other/fake.sql",
      "/db/file.sql",
      "api/v12/handler.ts",
      "api/v1/handler/x",
      "copy/db/file.sql",
    ]),
    [],
  );
  assert.deepEqual(
    selectMergeReviewers(specialized, {
      ...assessment,
      suggestedReviewers: ["general", "database"],
      pathOwners: ["API", "unconfigured", "database"],
    }),
    ["database", "api", "general"],
  );
  assert.deepEqual(
    selectMergeReviewers(saved, {
      ...assessment,
      criticalAreas: ["Changes to the AUTH boundary."],
    }),
    ["alice"],
  );
  assert.deepEqual(
    selectMergeReviewers(saved, {
      ...assessment,
      criticalAreas: ["Author attribution changed."],
    }),
    ["bob"],
  );
  for (const name of [
    "@org/team",
    "all",
    "here",
    "user\n/approve",
    "two names",
    "a@b",
    "a/b",
    "@alice",
  ]) {
    assert.equal(
      mergePolicySchema.safeParse({
        humanReviewers: [{ username: name, responsibilities: "Owner" }],
      }).success,
      false,
    );
  }
  assert.equal(
    mergePolicySchema.safeParse({
      humanReviewers: [
        humanReviewers[0],
        { ...humanReviewers[0], username: "ALICE" },
      ],
    }).success,
    false,
  );
  assert.deepEqual(
    selectMergeReviewers(saved, {
      ...assessment,
      suggestedReviewers: ["untrusted"],
    }),
    ["bob"],
  );
  assert.deepEqual(
    selectMergeReviewers(saved, { ...assessment, criticalAreas: ["auth"] }),
    ["alice"],
  );
  assert.deepEqual(
    selectMergeReviewers(saved, {
      ...assessment,
      suggestedReviewers: [
        "chris",
        "CHRIS",
        "alice",
        "bob",
        "dana",
        "untrusted",
      ],
    }),
    ["alice", "bob", "chris", "dana"],
  );
  const longLogin = "a".repeat(64);
  assert.ok(
    mergePolicySchema.safeParse({
      humanReviewers: [{ username: longLogin, responsibilities: "GitLab" }],
    }).success,
  );
  assert.equal(
    mergePolicySchema.safeParse({
      humanReviewers: [
        { username: longLogin + "a", responsibilities: "GitLab" },
      ],
    }).success,
    false,
  );
  const comment = {
    decision: {
      status: "human_review_required" as const,
      reasons: [
        { code: "gap", message: "@outsider [hey](https://invalid)\n/approve" },
      ],
      reviewers: ["ALICE", "alice", "alice", "outsider"],
    },
    headSha: "a".repeat(40),
    marker: "<!-- razbor:rev_abcdefghijklmnop:escalation -->",
    snapshot: { version: 1, policy: saved },
    assessment: { ...assessment, reasons: ["` \n/merge @all &#64;somebody"] },
  };
  const body = renderMergeEscalation(comment);
  const privateNote = "Management-only budget exception for project Alpha.";
  const evidence = {
    ...assessment,
    reasons: [privateNote],
    criticalAreas: [privateNote],
    verificationGaps: [privateNote],
    suggestedReviewers: [privateNote],
    pathOwners: ["private-path-owner"],
  };
  const oldDecision = {
    ...comment.decision,
    reasons: [
      { code: "critical_area", message: privateNote },
      { code: "verification_gap", message: privateNote },
      { code: "high_risk", message: "Risk" },
    ],
  };
  const safeBody = renderMergeEscalation({
    ...comment,
    assessment: evidence,
    decision: oldDecision,
  });
  assert.ok(!safeBody.includes(privateNote));
  const malformedBody = renderMergeEscalation({
    ...comment,
    assessment: {
      ...evidence,
      riskLevel: privateNote,
    } as unknown as MergeAssessment,
  });
  assert.ok(!malformedBody.includes(privateNote));
  assert.match(malformedBody, /score is unavailable/);
  assert.match(safeBody, /area that requires human review/);
  assert.match(safeBody, /verification remains incomplete/);
  assert.match(safeBody, /high or critical risk/);
  const refused = renderMergeEscalation({
    ...comment,
    decision: {
      status: "blocked",
      reviewers: [],
      reasons: [{ code: "merge_refused", message: privateNote }],
    },
  });
  assert.match(refused, /provider declined the guarded merge request/);
  assert.ok(!refused.includes(privateNote));
  assert.ok(
    !JSON.stringify(publicMergeDecision(oldDecision)).includes(privateNote),
  );
  assert.ok(
    !JSON.stringify(publicMergeAssessment(evidence)).includes(privateNote),
  );
  assert.equal(publicMergeAssessment(evidence).confidence, evidence.confidence);
  assert.equal(publicMergeAssessment(evidence).pathOwners, undefined);
  const long = renderMergeEscalation({
    ...comment,
    decision: { ...comment.decision, reviewers: [longLogin] },
    snapshot: {
      version: 1,
      policy: {
        ...saved,
        humanReviewers: [{ username: longLogin, responsibilities: "GitLab" }],
      },
    },
  });
  assert.ok(long.includes("@" + longLogin));
  assert.deepEqual(body.match(/@[\w.-]+/g), ["@alice"]);
  assert.equal(body.includes("\n/"), false);
  assert.ok(body.includes(comment.headSha) && body.endsWith(comment.marker));
  assert.doesNotMatch(
    renderMergeEscalation({ ...comment, mention: false }),
    /@[\w.-]+/,
  );
  assert.throws(() =>
    renderMergeEscalation({ ...comment, marker: "<!--\n@outsider -->" }),
  );
});
