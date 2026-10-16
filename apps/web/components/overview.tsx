"use client";

import Link from "next/link.js";
import { ArrowRight, RefreshCw } from "lucide-react";

import type { ReviewMetrics, RunnerView } from "@razbor/contracts";
import type { PullRequestView } from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import { PullRequestTable } from "@web/components/pull-request-table.js";
import { PullRequestRefresh } from "@web/components/pull-request-refresh.js";
import { ReviewMetricsPanel } from "@web/components/review-metrics.js";
import { usePullRequests } from "@web/lib/use-pull-requests.js";
import { usePoll } from "@web/lib/use-poll.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@web/components/ui/empty.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import { Badge } from "@web/components/ui/badge.js";
import { buttonVariants } from "@web/components/ui/button.js";

/** Shows live runner availability only for users authorized to read the management endpoint. */
function RunnerAvailability() {
  const snapshot = usePoll<{ runners: RunnerView[] }>(
    "/api/runners",
    undefined,
    15_000,
  );
  const runners = snapshot.data?.runners.filter(
    (runner) => runner.state !== "revoked",
  );
  const online = runners?.filter(
    (runner) => runner.status === "online" || runner.status === "busy",
  ).length;
  return (
    <Link
      href="/runners"
      className="console-hero-status hover:border-primary/40"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${snapshot.error || !online ? "bg-muted-foreground" : "bg-success"}`}
      />
      <span>Runners online</span>
      <span className="font-medium tabular-nums text-foreground">
        {snapshot.error
          ? "Unavailable"
          : runners
            ? `${online} / ${runners.length}`
            : "—"}
      </span>
    </Link>
  );
}

/** Presents live review totals, the open human review queue, and recent automated activity. */
export default function Overview({
  initialMetrics,
  initialPullRequests,
  showRunnerStatus = false,
}: Readonly<{
  initialMetrics?: ReviewMetrics;
  initialPullRequests?: PullRequestView[];
  showRunnerStatus?: boolean;
}>) {
  const pullRequests = usePullRequests<PullRequestView[]>(
    "/api/pull-requests",
    initialPullRequests,
  );
  const openPullRequests = pullRequests.data?.filter(
    (pr) => pr.state === "open",
  );
  const pullRequestContent = (
    <section
      aria-labelledby="human-review"
      className="overview-pull-requests flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="human-review"
            className="flex items-baseline gap-2 text-lg font-semibold"
          >
            Open pull requests
            <Badge variant="secondary" className="h-6 min-w-7 tabular-nums">
              {openPullRequests?.length ?? "—"}
            </Badge>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pull requests waiting for human review.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PullRequestRefresh
            refreshing={pullRequests.refreshing}
            refresh={pullRequests.refresh}
          />
          <Link
            href="/pull-requests"
            className={buttonVariants({ variant: "outline", size: "default" })}
          >
            View all pull requests
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Link>
        </div>
      </div>
      {(pullRequests.warning || pullRequests.error) && (
        <Alert>
          <AlertDescription>
            {pullRequests.warning ||
              "Saved pull requests are unavailable. Retrying…"}
          </AlertDescription>
        </Alert>
      )}
      {!pullRequests.data ? (
        !pullRequests.error && <Skeleton className="h-48 w-full" />
      ) : openPullRequests?.length ? (
        <>
          <PullRequestTable pullRequests={openPullRequests.slice(0, 5)} />
          {openPullRequests.length > 5 && (
            <Link
              href="/pull-requests"
              className="text-sm text-muted-foreground hover:underline"
            >
              View all {openPullRequests.length} open pull requests →
            </Link>
          )}
        </>
      ) : (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyTitle>
              {pullRequests.refreshing
                ? "Checking connected repositories…"
                : "No open pull requests"}
            </EmptyTitle>
            <EmptyDescription>
              {pullRequests.warning
                ? "The saved snapshot has no open pull requests. Refresh to check the current provider state."
                : "Open pull requests from your connected repositories appear here after a successful refresh."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
  return (
    <main className="console-hero-page overview-page flex min-w-0 flex-col">
      <ConsoleHero
        id="overview-title"
        eyebrow="Code review, automated"
        title="Overview"
        description="Changes waiting for human review, with automated findings ready to inspect."
      >
        {showRunnerStatus ? (
          <RunnerAvailability />
        ) : (
          <span className="console-hero-status">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-primary"
            />
            Open pull requests
            <span className="font-medium tabular-nums text-foreground">
              {openPullRequests?.length ?? "—"}
            </span>
          </span>
        )}
        <span className="console-hero-status">
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refreshes automatically
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <ReviewMetricsPanel initialMetrics={initialMetrics} summaryOnly>
          {pullRequestContent}
        </ReviewMetricsPanel>
      </div>
    </main>
  );
}
