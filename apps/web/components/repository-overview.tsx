"use client";

import type { ReviewMetrics } from "@razbor/contracts";
import type { PullRequestView } from "@razbor/database";

import { RepositoryPullRequests } from "@web/components/repository-pull-requests.js";
import { ReviewMetricsPanel } from "@web/components/review-metrics.js";

/** Keeps the repository dashboard on the same measured totals and calendar as the main overview. */
export function RepositoryOverview({
  id,
  initialMetrics,
  initialPullRequests,
}: Readonly<{
  id: string;
  initialMetrics?: ReviewMetrics;
  initialPullRequests?: PullRequestView[];
}>) {
  return (
    <ReviewMetricsPanel
      repositoryId={id}
      initialMetrics={initialMetrics}
      summaryOnly
    >
      <RepositoryPullRequests
        id={id}
        initialData={initialPullRequests}
        summaryOnly
      />
    </ReviewMetricsPanel>
  );
}
