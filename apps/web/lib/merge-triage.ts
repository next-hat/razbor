import type { MergeDecisionStatus, ReviewJobView } from "@razbor/contracts";
import type { PullRequestView } from "@razbor/database";

export const decisionLabels = {
  human_review_required: "Needs human review",
  blocked: "Blocked",
  awaiting_checks: "Awaiting checks",
  review_in_progress: "Review in progress",
  auto_merge_eligible: "Auto-merge eligible",
  stale: "Earlier decision",
  merged: "Merged",
} satisfies Record<MergeDecisionStatus, string>;

export const actionLabels = {
  dry_run: "Dry run · would schedule",
  writing: "Confirming merge request",
  scheduled: "Merge scheduled",
  merged: "Merged",
  uncertain: "Merge outcome unconfirmed",
  refused: "Merge request refused",
} satisfies Record<NonNullable<ReviewJobView["mergeAction"]>, string>;

const riskOrder = { critical: 4, high: 3, medium: 2, low: 1 };

export const orderLabels = {
  attention: "Human attention first",
  confidence: "Lowest confidence",
  risk: "Highest risk",
  repository: "Repository name",
  review: "Review status",
  decision: "Merge decision",
  age: "Oldest tracked first",
  updated: "Recently updated",
};

export type QueueFilters = {
  decision: string;
  repository: string;
  risk: string;
  review: string;
  confidence: string;
  updatedDays: string;
  order: keyof typeof orderLabels;
};

export const initialQueueFilters: QueueFilters = {
  decision: "",
  repository: "",
  risk: "",
  review: "",
  confidence: "",
  updatedDays: "",
  order: "attention",
};

/** Prioritize escalations, intervention, pending verification, active review and eligible requests in that order. */
function attention(pr: PullRequestView) {
  if (pr.state === "closed") return 5;
  const status = pr.merge?.decision.status;
  if (status === "human_review_required") return 0;
  if (
    status === "blocked" ||
    pr.merge?.action === "uncertain" ||
    pr.merge?.action === "refused" ||
    pr.latestReview?.status === "failed"
  )
    return 1;
  if (status === "auto_merge_eligible" || status === "merged") return 4;
  if (
    status === "review_in_progress" ||
    (!status && ["running", "queued"].includes(pr.latestReview?.status ?? ""))
  )
    return 3;
  return 2;
}

/** Filter the caller's already-granted snapshot; use only current decision evidence for confidence and risk. */
export function triageQueue(
  prs: PullRequestView[],
  filter: QueueFilters,
  now = Date.now(),
) {
  const selected = prs.filter(
    (pr) =>
      (!filter.repository || pr.repositoryId === filter.repository) &&
      (!filter.decision ||
        (pr.merge?.decision.status ?? "undecided") === filter.decision) &&
      (!filter.risk || pr.merge?.riskLevel === filter.risk) &&
      (!filter.review ||
        (pr.latestReview?.status ?? "unreviewed") === filter.review) &&
      (!filter.confidence ||
        (pr.merge?.confidence !== undefined &&
          pr.merge.confidence <= Number(filter.confidence))) &&
      (!filter.updatedDays ||
        Date.parse(pr.updatedAt) >=
          now - Number(filter.updatedDays) * 86400000),
  );
  return selected.sort((a, b) => {
    let diff: number;
    switch (filter.order) {
      case "confidence":
        diff = (a.merge?.confidence ?? 101) - (b.merge?.confidence ?? 101);
        break;
      case "risk":
        diff =
          (b.merge?.riskLevel ? riskOrder[b.merge.riskLevel] : 0) -
          (a.merge?.riskLevel ? riskOrder[a.merge.riskLevel] : 0);
        break;
      case "repository":
        diff = a.repositoryName.localeCompare(b.repositoryName);
        break;
      case "review":
        diff = (a.latestReview?.status ?? "unreviewed").localeCompare(
          b.latestReview?.status ?? "unreviewed",
        );
        break;
      case "decision":
        diff = (a.merge?.decision.status ?? "undecided").localeCompare(
          b.merge?.decision.status ?? "undecided",
        );
        break;
      case "age":
        diff = a.createdAt.localeCompare(b.createdAt);
        break;
      case "updated":
        diff = 0;
        break;
      case "attention":
        diff = attention(a) - attention(b);
        break;
    }
    return (
      diff || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
    );
  });
}
