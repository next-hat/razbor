/** Counts for review execution, changed code, finding outcomes, and observed usage. */
export type ReviewMetricTotals = {
  completedReviews: number;
  failedReviews: number;
  queuedReviews: number;
  runningReviews: number;
  conversationReplies: number;
  addedLines: number;
  deletedLines: number;
  distinctAddedLines: number;
  distinctDeletedLines: number;
  changedFiles: number;
  diffMeasuredReviews: number;
  distinctDiffs: number;
  findings: number;
  confirmedResolvedFindings: number;
  noLongerReportedFindings: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  attempts: number;
  usageRecordedAttempts: number;
  completeUsageAttempts: number;
  cachedUsageRecordedAttempts: number;
  averageDurationMs: number | null;
  durationMeasuredReviews: number;
};

/** A named repository and its metrics for the selected reporting period. */
export type RepositoryReviewMetrics = {
  repositoryId: string;
  repositoryName: string;
  totals: ReviewMetricTotals;
};

/** Stable grouping for a forge change, source branch, or unattributed commit pair. */
export type ReviewMetricTarget = {
  key: string;
  kind: "change" | "branch" | "revision";
  label: string;
  number?: number;
  url?: string;
  headBranch?: string;
  baseBranch?: string;
};

/** Metrics attached to one repository-specific pull request, merge request, or branch. */
export type TargetReviewMetrics = RepositoryReviewMetrics & {
  target: ReviewMetricTarget;
};

/** Completed reviews for one UTC calendar day, including days with no activity. */
export type ReviewActivityDay = {
  date: string;
  completedReviews: number;
};

/** Durable dashboard snapshot; null start means the entire retained review history. */
export type ReviewMetrics = {
  asOf: string;
  range: { from: string | null; to: string };
  totals: ReviewMetricTotals;
  activity: ReviewActivityDay[];
  repositories: RepositoryReviewMetrics[];
  targets: TargetReviewMetrics[];
};
