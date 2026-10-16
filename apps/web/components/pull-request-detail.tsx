"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { useState } from "react";
import { ArrowUpRight, GitPullRequest, GitBranch } from "lucide-react";

import type { PullRequestDetail } from "@razbor/database";
import { safeReviewUrl } from "@razbor/contracts/presentation";

import { ConsoleHero } from "@web/components/console-hero.js";
import { PullRequestRefresh } from "@web/components/pull-request-refresh.js";
import { ReviewResult } from "@web/components/review-result.js";
import { Status } from "@web/components/status.js";
import { usePullRequests } from "@web/lib/use-pull-requests.js";
import { formatUtc } from "@web/lib/date.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@web/components/ui/empty.js";
import { Skeleton } from "@web/components/ui/skeleton.js";

/**
 * Shows the latest completed findings with their exact revision and keeps prior
 * runs addressable. Automated completion does not represent human approval.
 */
export default function PullRequestPage({
  id,
  initialData,
  isAdmin = false,
}: Readonly<{
  id: string;
  initialData?: PullRequestDetail;
  isAdmin?: boolean;
}>) {
  const snapshot = usePullRequests<PullRequestDetail>(
    `/api/pull-requests/${id}`,
    initialData,
  );
  const pr = snapshot.data;
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const completed = pr?.reviews.find(
    (review) => review.status === "completed" && review.review,
  );
  const earlierRevision =
    completed &&
    pr &&
    (completed.headSha !== pr.headSha ||
      (completed.targetBaseSha && completed.targetBaseSha !== pr.baseSha));

  /** Requests this PR's saved revision after the server resolves its repository grant and current commit IDs. */
  async function triggerReview() {
    if (!pr || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    setSubmitted(false);
    try {
      const response = await fetch(`/api/pull-requests/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error || "Unable to request review. Try again.");
      setSubmitted(true);
      router.refresh();
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Unable to request review. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <main className="console-hero-page flex min-w-0 flex-col">
      <ConsoleHero
        id="pull-request-title"
        eyebrow="Human review"
        title="Pull request"
        description="Inspect automated findings, the reviewed revision, and prior review runs."
        breadcrumbLabel={pr ? `#${pr.number}` : "Details"}
        breadcrumbs={[{ label: "Pull requests", href: "/pull-requests" }]}
      >
        {pr && (
          <>
            <span className="console-hero-status">
              <GitPullRequest aria-hidden="true" className="size-4" />
              {pr.state === "open" ? "Open · human review" : "Closed"}
            </span>
            <span className="console-hero-status tabular-nums">
              {pr.reviewCount} review {pr.reviewCount === 1 ? "run" : "runs"}
            </span>
          </>
        )}
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-6">
        <section className="console-card flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-xl font-semibold tracking-tight">
                {pr?.title ?? "Pull request details"}
              </h2>
              {pr && (
                <p className="mt-2 break-words text-sm text-muted-foreground">
                  {pr.repositoryName} #{pr.number}
                  {pr.author ? ` · by ${pr.author}` : ""}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PullRequestRefresh
                refreshing={snapshot.refreshing}
                refresh={snapshot.refresh}
              />
              {pr && (
                <>
                  <Button
                    disabled={submitting}
                    onClick={() => void triggerReview()}
                  >
                    <GitPullRequest data-icon="inline-start" />
                    {submitting ? "Requesting…" : "Trigger review"}
                  </Button>
                  <a
                    href={safeReviewUrl(pr.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline" })}
                  >
                    Open on forge
                    <ArrowUpRight data-icon="inline-end" />
                  </a>
                </>
              )}
            </div>
          </div>
        </section>
        {submitError && (
          <Alert variant="destructive">
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}
        {submitted && (
          <output aria-live="polite" className="text-sm text-muted-foreground">
            Review requested for this pull request.
          </output>
        )}
        {(snapshot.warning || snapshot.error) && (
          <Alert>
            <AlertDescription>
              {snapshot.warning ||
                "Pull request details are unavailable. Retrying…"}
            </AlertDescription>
          </Alert>
        )}
        {!pr ? (
          !snapshot.error && <Skeleton className="h-64 w-full" />
        ) : (
          <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <section
              className="flex min-w-0 flex-col gap-4"
              aria-labelledby="latest-findings"
            >
              <div className="console-card flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div>
                  <h2 id="latest-findings" className="text-base font-semibold">
                    Latest review
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {completed
                      ? `From the latest completed review · ${formatUtc(completed.finishedAt ?? completed.submittedAt)}`
                      : "An automated review has not completed yet."}
                  </p>
                </div>
                {completed && (
                  <Link
                    href={`/jobs/${completed.id}`}
                    className={buttonVariants({ variant: "outline" })}
                  >
                    View review run
                    <ArrowUpRight data-icon="inline-end" />
                  </Link>
                )}
              </div>
              {earlierRevision && (
                <Alert>
                  <AlertDescription>
                    These findings apply to an earlier revision. The current
                    pull request has changed since this review.
                  </AlertDescription>
                </Alert>
              )}
              {completed?.review ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">
                      Reviewed commit{" "}
                      <code className="break-all">
                        {completed.headSha?.slice(0, 12) ?? "Not recorded"}
                      </code>
                    </Badge>
                    <Badge variant="outline">
                      Diff base{" "}
                      <code>
                        {completed.baseSha?.slice(0, 12) ?? "Not recorded"}
                      </code>
                    </Badge>
                  </div>
                  <ReviewResult
                    key={completed.id}
                    review={completed.review}
                    reviewId={isAdmin ? completed.id : undefined}
                    evaluation={completed.evaluation}
                    defaultExpanded
                  />
                </>
              ) : (
                <Empty className="border bg-card">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <GitPullRequest />
                    </EmptyMedia>
                    <EmptyTitle>Waiting for a review result</EmptyTitle>
                    <EmptyDescription>
                      {pr.latestReview
                        ? "The latest review has no completed result. Open its run below for the current status."
                        : "Select Trigger review to request a review of this pull request. Findings will appear here when it completes."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>
            <aside className="flex min-w-0 flex-col gap-6">
              <section
                className="console-card flex flex-col gap-4"
                aria-labelledby="pr-context"
              >
                <h2 id="pr-context" className="font-semibold">
                  Pull request details
                </h2>
                <dl className="flex flex-col gap-4 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Repository
                    </dt>
                    <dd className="mt-1 break-words">
                      <Link
                        href={`/repos/${pr.repositoryId}`}
                        className="font-medium hover:underline"
                      >
                        {pr.repositoryName}
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Branches</dt>
                    <dd className="mt-1 flex items-start gap-2">
                      <GitBranch
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="break-all font-mono text-xs leading-6">
                        {pr.headBranch ?? "Source"} →{" "}
                        {pr.baseBranch ?? "Target"}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Current commit
                    </dt>
                    <dd className="mt-1 break-all font-mono text-xs">
                      {pr.headSha}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Last synchronized
                    </dt>
                    <dd className="mt-1 text-xs">{formatUtc(pr.syncedAt)}</dd>
                  </div>
                </dl>
                <p className="text-xs leading-5 text-muted-foreground">
                  {pr.state === "open"
                    ? "This pull request is waiting for human review before merging."
                    : "This pull request is no longer open. Its saved reviews remain available."}
                </p>
              </section>
              <section
                className="console-card flex flex-col gap-4"
                aria-labelledby="review-history"
              >
                <div className="flex items-center justify-between">
                  <h2 id="review-history" className="font-semibold">
                    Review history
                  </h2>
                  <Badge variant="secondary">{pr.reviewCount}</Badge>
                </div>
                {pr.reviews.length ? (
                  <ol className="flex flex-col gap-3">
                    {pr.reviews.map((review) => (
                      <li
                        key={review.id}
                        className="overflow-hidden rounded-lg border"
                      >
                        <Link
                          href={`/jobs/${review.id}`}
                          className="flex flex-col gap-2 p-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <code className="text-xs">
                              {review.headSha?.slice(0, 12) ?? review.id}
                            </code>
                            <Status value={review.status} />
                          </div>
                          <span className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                            <span>{formatUtc(review.submittedAt)}</span>
                            {review.review && (
                              <span>
                                {review.review.findings.length} findings
                              </span>
                            )}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No automated reviews requested yet.
                  </p>
                )}
              </section>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
