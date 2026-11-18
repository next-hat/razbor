import { z } from "zod";

import type { JobStatus, ReviewResult } from "@contracts/src/index.js";

export const MAX_POLICY_BYTES = 32768;

export const MAX_ESCALATION_MENTIONS = 3;

export const reviewerUsernameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
  .refine(
    (name) =>
      !["all", "here", "everyone", "channel"].includes(name.toLowerCase()),
    "Use an individual reviewer username.",
  );

// PostgreSQL JSONB rejects zero bytes and isolated UTF-16 surrogate halves.
const textValue = z
  .string()
  .refine(
    (value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value),
    "Use valid Unicode text without null characters.",
  );

const description = textValue.trim().min(1).max(800);

const reviewerSchema = z.strictObject({
  username: reviewerUsernameSchema,
  label: textValue.trim().min(1).max(100).optional(),
  responsibilities: description,
  pathPatterns: z.array(textValue.trim().min(1).max(256)).max(16).optional(),
  riskCategories: z.array(textValue.trim().min(1).max(100)).max(16).optional(),
});

const policyMarkdown = textValue
  .max(MAX_POLICY_BYTES)
  .refine(
    (value) => new TextEncoder().encode(value).length <= MAX_POLICY_BYTES,
    "Merge Policy must fit within 32 KiB of UTF-8 text.",
  );

const humanReviewers = z
  .array(reviewerSchema)
  .max(24)
  .refine(
    (items) =>
      new Set(items.map((item) => item.username.toLowerCase())).size ===
      items.length,
    "Each reviewer must have a distinct username.",
  );

export const mergePolicySchema = z.strictObject({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  minimumConfidence: z.number().int().min(0).max(100).default(90),
  mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
  requirePassingChecks: z.boolean().default(true),
  defaultBranchOnly: z.boolean().default(true),
  policyMarkdown: policyMarkdown.default(""),
  humanReviewers: humanReviewers.default([]),
});

export type MergePolicy = z.infer<typeof mergePolicySchema>;

export const mergePolicySnapshotSchema = z.strictObject({
  version: z.number().int().positive().safe(),
  // Configuration defaults apply at save time. Partial snapshots cannot authorize a review.
  policy: mergePolicySchema.required(),
});

export type MergePolicySnapshot = z.infer<typeof mergePolicySnapshotSchema>;

export const mergeRiskSchema = z.enum(["low", "medium", "high", "critical"]);

export const mergeAssessmentSchema = z.strictObject({
  confidence: z.number().int().min(0).max(100),
  riskLevel: mergeRiskSchema,
  reviewComplete: z.boolean(),
  requiresHumanReview: z.boolean(),
  reasons: z.array(description).min(1).max(12),
  criticalAreas: z.array(description).max(12),
  verificationGaps: z.array(description).max(12),
  // Preserve old assessment feedback; only legal, configured IDs can become candidates.
  suggestedReviewers: z.array(textValue.trim().min(1).max(100)).max(24),
});

export type MergeAssessment = z.infer<typeof mergeAssessmentSchema>;

export const mergeDecisionStatusSchema = z.enum([
  "auto_merge_eligible",
  "human_review_required",
  "awaiting_checks",
  "blocked",
  "review_in_progress",
  "stale",
  "merged",
]);

export type MergeDecisionStatus = z.infer<typeof mergeDecisionStatusSchema>;

export type MergeDecision = {
  status: MergeDecisionStatus;
  reasons: { code: string; message: string }[];
  reviewers: string[];
};

export type MergeDecisionInput = {
  snapshot?: MergePolicySnapshot | null;
  currentPolicyVersion: number;
  reviewStatus: JobStatus;
  result?: ReviewResult | null;
  /** Count of unresolved historical findings. */
  outstandingFindings: number;
  /** The server has reconciled all saved finding checks against current provider evidence. */
  outstandingFindingsAudited?: boolean;
  /** Includes base, head, target branch and identity of the latest authorized review. */
  revisionCurrent: boolean;
  open: boolean;
  draft: boolean;
  baseBranch?: string | null;
  defaultBranch?: string | null;
  humanEscalated: boolean;
  provider: {
    guarded: boolean;
    checks: "passing" | "pending" | "failed" | "unknown";
    restrictions: "satisfied" | "pending" | "blocked" | "unknown";
    merged?: boolean;
    reason?: string;
  };
};

/** Rank configured candidates by model recommendation and matching ownership, then use the first general reviewer or configured candidate. */
export function selectMergeReviewers(
  policy: MergePolicy,
  assessment?: MergeAssessment,
): string[] {
  const suggestions = new Set(
    assessment?.suggestedReviewers
      .filter((name) => reviewerUsernameSchema.safeParse(name).success)
      .map((name) => name.toLowerCase()),
  );
  const areas = new Set(
    assessment?.criticalAreas.map((area) => area.toLowerCase()),
  );
  if (assessment) areas.add(assessment.riskLevel);
  const matches = policy.humanReviewers.filter(
    (candidate) =>
      suggestions.has(candidate.username.toLowerCase()) ||
      candidate.riskCategories?.some((area) => areas.has(area.toLowerCase())),
  );
  if (matches.length) return matches.map((candidate) => candidate.username);
  const fallback =
    policy.humanReviewers.find(
      (candidate) =>
        !candidate.pathPatterns?.length && !candidate.riskCategories?.length,
    ) ?? policy.humanReviewers[0];
  return fallback ? [fallback.username] : [];
}

const humanReasons = {
  missing_policy_snapshot: "This review has no saved merge policy.",
  missing_assessment: "This review has no merge readiness assessment.",
  confidence_below_threshold:
    "Merge confidence is below the repository threshold.",
  incomplete_review: "The reviewer could not complete the investigation.",
  explicit_human_review: "The reviewer requested human review.",
  high_risk: "The review identified high or critical risk.",
  critical_area: "The change affects an area that requires human review.",
  verification_gap: "Some required verification remains incomplete.",
  actionable_findings: "The review reported actionable findings.",
  outstanding_findings:
    "Prior finding reconciliation has unresolved or uncertain findings.",
  previously_escalated:
    "This pull request was escalated to the provider's human-controlled merge workflow.",
};

/** Replace policy-derived messages from historical decisions before exposing a review to a reader. */
export function publicMergeDecision(decision: MergeDecision): MergeDecision {
  const seen = new Set<string>();
  return {
    ...decision,
    reasons: decision.reasons.flatMap((reason) => {
      if (!Object.hasOwn(humanReasons, reason.code)) return [reason];
      if (seen.has(reason.code)) return [];
      seen.add(reason.code);
      return [
        {
          code: reason.code,
          message: humanReasons[reason.code as keyof typeof humanReasons],
        },
      ];
    }),
  };
}

/** Expose the recorded score and readiness signals without the model's private policy-derived prose. */
export function publicMergeAssessment(
  assessment: MergeAssessment,
): MergeAssessment {
  return {
    confidence: assessment.confidence,
    riskLevel: assessment.riskLevel,
    reviewComplete: assessment.reviewComplete,
    requiresHumanReview: assessment.requiresHumanReview,
    reasons: [
      "Detailed assessment notes are available to repository managers.",
    ],
    criticalAreas: assessment.criticalAreas.length
      ? [humanReasons.critical_area]
      : [],
    verificationGaps: assessment.verificationGaps.length
      ? [humanReasons.verification_gap]
      : [],
    suggestedReviewers: [],
  };
}

/** Evaluate trusted review, policy and provider facts without side effects. Missing or indeterminate evidence never confers eligibility. */
export function evaluateMergeDecision(
  input: MergeDecisionInput,
): MergeDecision {
  const { result, provider } = input;
  const parsed = mergePolicySnapshotSchema.safeParse(input.snapshot);
  const snapshot = parsed.success ? parsed.data : undefined;
  /** Make a single-gate result without notifying reviewers for operational states. */
  const decision = (
    status: MergeDecisionStatus,
    code: string,
    message: string,
  ): MergeDecision => ({
    status,
    reasons: [{ code, message }],
    reviewers: [],
  });
  if (provider.merged === true)
    return decision(
      "merged",
      "provider_merged",
      "The provider confirms this pull request was merged.",
    );
  if (input.snapshot && !snapshot)
    return decision(
      "blocked",
      "invalid_policy_snapshot",
      "The saved policy is invalid.",
    );
  if (
    !input.revisionCurrent ||
    (snapshot && snapshot.version !== input.currentPolicyVersion)
  ) {
    return decision(
      "stale",
      "review_superseded",
      "The review revisions or saved policy are no longer current.",
    );
  }
  if (!input.open || input.draft !== false)
    return decision(
      "blocked",
      "change_not_ready",
      "The pull request must be open and ready for review.",
    );
  if (input.reviewStatus === "queued" || input.reviewStatus === "running")
    return decision(
      "review_in_progress",
      "review_pending",
      "The current review has not finished.",
    );
  if (input.reviewStatus !== "completed")
    return decision(
      "blocked",
      "review_failed",
      "A successful review of this change is required.",
    );

  const reasons: MergeDecision["reasons"] = [];
  const validated = mergeAssessmentSchema.safeParse(result?.mergeAssessment);
  const assessment = validated.success ? validated.data : undefined;
  /** Collect every human-facing impediment to the same review so a fix addresses the full decision. */
  const add = (code: keyof typeof humanReasons) =>
    reasons.push({ code, message: humanReasons[code] });
  if (!snapshot) add("missing_policy_snapshot");
  if (!assessment || result?.mode === "conversation") add("missing_assessment");
  if (assessment) {
    if (snapshot && assessment.confidence < snapshot.policy.minimumConfidence)
      add("confidence_below_threshold");
    if (!assessment.reviewComplete) add("incomplete_review");
    if (assessment.requiresHumanReview) add("explicit_human_review");
    if (assessment.riskLevel === "high" || assessment.riskLevel === "critical")
      add("high_risk");
    if (assessment.criticalAreas.length) add("critical_area");
    if (assessment.verificationGaps.length) add("verification_gap");
  }
  if (result?.findings.length) add("actionable_findings");
  if (
    input.outstandingFindings !== 0 ||
    (!input.outstandingFindingsAudited &&
      result?.findingChecks?.some((check) => check.status !== "resolved"))
  )
    add("outstanding_findings");
  if (input.humanEscalated && !reasons.length) add("previously_escalated");
  if (reasons.length)
    return {
      status: "human_review_required",
      reasons,
      reviewers: snapshot
        ? selectMergeReviewers(snapshot.policy, assessment)
        : [],
    };
  if (!snapshot?.policy.enabled)
    return decision(
      "blocked",
      "automation_disabled",
      "Merge automation is disabled for this repository.",
    );
  // The initial release has no additional destination branch allowlist.
  if (!input.defaultBranch || input.baseBranch !== input.defaultBranch)
    return decision(
      "blocked",
      "target_not_allowed",
      "Only the repository default branch is an authorized destination.",
    );
  if (!provider.guarded)
    return decision(
      "blocked",
      "guard_unavailable",
      provider.reason ||
        "The provider cannot enforce a guarded merge for this change.",
    );
  if (
    provider.restrictions === "blocked" ||
    provider.restrictions === "unknown"
  )
    return decision(
      "blocked",
      "provider_restrictions",
      provider.reason ||
        "Provider permission or merge restrictions prevent authorization.",
    );
  if (
    snapshot.policy.requirePassingChecks &&
    (provider.checks === "failed" || provider.checks === "unknown")
  )
    return decision(
      "blocked",
      "checks_unverified",
      provider.reason ||
        "Required provider checks failed or could not be verified.",
    );
  if (
    provider.restrictions !== "satisfied" ||
    (snapshot.policy.requirePassingChecks && provider.checks !== "passing")
  )
    return decision(
      "awaiting_checks",
      "provider_pending",
      provider.reason ||
        "Provider checks or native merge requirements are pending.",
    );
  return decision(
    "auto_merge_eligible",
    "requirements_met",
    snapshot.policy.dryRun
      ? "Dry run. The reviewed revision meets the configured merge requirements."
      : "The reviewed revision meets the configured merge requirements.",
  );
}

/** Render untrusted text as a single literal Markdown span, suppressing provider mentions, HTML entities and slash commands. */
function commentLiteral(text: string): string {
  return (
    "`" +
    text
      .replaceAll("`", "′")
      .replaceAll("@", "＠")
      .replaceAll("&", "＆")
      .replace(/\s+/g, " ")
      .trim() +
    "`"
  );
}

const publicEscalationReasons = {
  ...humanReasons,
  provider_merged: "The provider confirmed the reviewed revision was merged.",
  change_closed: "The provider reports that the pull request is closed.",
  target_not_allowed:
    "Only the repository default branch is an authorized destination.",
  review_failed: "A successful review of this change is required.",
  automation_disabled: "Merge automation is disabled for this repository.",
  merge_refused: "The provider declined the guarded merge request.",
  write_uncertain:
    "The provider has not confirmed the outcome of the merge request.",
  prior_write_uncertain:
    "An older native merge request requires reconciliation.",
  provider_unavailable:
    "The provider could not verify the current merge conditions.",
  publication_incomplete:
    "Finding publication and reconciliation must finish before merging.",
  remote_revision_changed:
    "The provider revision or draft state changed. A current review is required.",
  checks_unverified:
    "Required provider checks failed or could not be verified.",
  guard_unavailable:
    "The provider cannot enforce a guarded merge for this change.",
  provider_restrictions:
    "Provider restrictions or permissions prevent a guarded merge.",
};

const statusReason: Record<MergeDecisionStatus, string> = {
  merged: "The provider confirmed the reviewed revision was merged.",
  human_review_required: "A human reviewer must assess this change.",
  stale: "The previous merge decision is out of date.",
  review_in_progress: "The current review has not finished.",
  awaiting_checks: "Provider checks or merge requirements are pending.",
  auto_merge_eligible:
    "The reviewed revision meets the configured merge requirements.",
  blocked: "The service could not confirm all conditions required for a merge.",
};

/** Build a revision-bound triage comment. Recheck the allowlist even for saved decisions and limit mentions to a first notification. */
export function renderMergeEscalation(input: {
  decision: MergeDecision;
  snapshot: MergePolicySnapshot;
  assessment?: MergeAssessment | null;
  headSha: string;
  marker: string;
  mention?: boolean;
}): string {
  const { decision, snapshot } = input;
  const parsed = mergeAssessmentSchema.safeParse(input.assessment);
  const assessment = parsed.success ? parsed.data : undefined;
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.headSha) ||
    !/^<!-- razbor:[A-Za-z0-9:_-]+ -->$/.test(input.marker)
  )
    throw new Error("Invalid escalation revision or marker.");
  const human = decision.status === "human_review_required";
  const lines = [
    human
      ? "**Razbor — Human review required**"
      : "**Razbor — Review decision updated**",
    "",
    ...(assessment
      ? [
          `Merge confidence: ${assessment.confidence}/100 (uncalibrated model assessment)  `,
          `Required threshold: ${snapshot.policy.minimumConfidence}/100  `,
          `Risk: ${assessment.riskLevel}`,
        ]
      : ["A merge readiness score is unavailable."]),
    "",
    ...(!human ? [`Decision: ${decision.status}`, ""] : []),
  ];
  // Only service-owned explanations can leave the management boundary. Old
  // decisions and valid model evidence can both contain verbatim policy prose.
  const reasons = [
    ...new Set(
      decision.reasons.flatMap(({ code }) =>
        Object.hasOwn(publicEscalationReasons, code)
          ? [
              publicEscalationReasons[
                code as keyof typeof publicEscalationReasons
              ],
            ]
          : [],
      ),
    ),
  ];
  if (!reasons.length) reasons.push(statusReason[decision.status]);
  lines.push("Reasons:", ...reasons.map((message) => "- " + message));
  const allowed = new Set(
    snapshot.policy.humanReviewers.map((candidate) => candidate.username),
  );
  const reviewers = [...new Set(decision.reviewers)]
    .filter(
      (name) =>
        allowed.has(name) && reviewerUsernameSchema.safeParse(name).success,
    )
    .slice(0, MAX_ESCALATION_MENTIONS);
  if (human && reviewers.length)
    lines.push(
      "",
      "Suggested reviewers: " +
        reviewers
          .map((name) =>
            input.mention === false ? commentLiteral(name) : "@" + name,
          )
          .join(" "),
    );
  lines.push(
    "",
    "Reviewed commit: " + commentLiteral(input.headSha),
    "",
    input.marker,
  );
  return lines.join("\n");
}
