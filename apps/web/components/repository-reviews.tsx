"use client";

import Link from "next/link.js";
import { GitPullRequest, ArrowRight } from "lucide-react";

import type { ReviewJobView } from "@razbor/contracts";
import { reviewDisplayName } from "@razbor/contracts/presentation";

import { usePoll } from "@web/lib/use-poll.js";
import { formatUtc } from "@web/lib/date.js";
import { Status } from "@web/components/status.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { buttonVariants } from "@web/components/ui/button.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@web/components/ui/empty.js";

/**
 * Refreshes repository review history with metadata that wraps below readable titles
 * on narrow screens. Empty histories offer setup guidance only to administrators.
 */
export function RepositoryReviews({
  id,
  initialData,
  isAdmin = false,
  reviewCommand = null,
}: Readonly<{
  id: string;
  initialData?: ReviewJobView[];
  isAdmin?: boolean;
  reviewCommand?: string | null;
}>) {
  const { data, error } = usePoll(
    `/api/repositories/${id}/reviews`,
    initialData,
  );
  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-labelledby="review-activity"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="review-activity" className="text-base font-semibold">
            Review activity
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Reviews requested for this repository.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">Latest 50 reviews</span>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Reviews are unavailable. Retrying…
          </AlertDescription>
        </Alert>
      )}
      {data?.length ? (
        <div className="console-table overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="console-table-primary w-[46%]">
                  Review
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="console-table-actions w-40">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((review) => (
                <TableRow key={review.id}>
                  <TableCell
                    className="console-table-primary"
                    data-label="Review"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                        <GitPullRequest
                          className="size-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <Link
                          href={`/jobs/${review.id}`}
                          className="break-words font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {reviewDisplayName(review)}
                        </Link>
                        <span className="break-all font-mono text-xs text-muted-foreground">
                          {review.id}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell data-label="Status">
                    <Status value={review.status} />
                  </TableCell>
                  <TableCell data-label="Submitted">
                    <time
                      dateTime={review.submittedAt}
                      className="text-xs tabular-nums text-muted-foreground"
                    >
                      {formatUtc(review.submittedAt)}
                    </time>
                  </TableCell>
                  <TableCell
                    className="console-table-actions"
                    data-label="Actions"
                  >
                    <Link
                      href={`/jobs/${review.id}`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                      aria-label={`Open ${reviewDisplayName(review)}`}
                    >
                      Open review
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        data && (
          <Empty className="min-h-60 rounded-lg border bg-card">
            <EmptyHeader>
              <GitPullRequest
                className="mx-auto mb-2 size-8 text-muted-foreground"
                aria-hidden="true"
              />
              <EmptyTitle>No reviews yet</EmptyTitle>
              <EmptyDescription>
                {isAdmin && reviewCommand ? (
                  <>
                    Comment <code>{reviewCommand}</code> on a pull request to
                    request a review.
                  </>
                ) : (
                  "Reviews for this repository will appear here."
                )}
                {isAdmin && (
                  <>
                    <br />
                    <Link
                      href={`/repos/${id}/settings`}
                      className="underline underline-offset-4"
                    >
                      Configure the repository webhook in Settings.
                    </Link>
                  </>
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}
      {!data && !error && (
        <div
          className="console-card text-sm text-muted-foreground"
          role="status"
        >
          Loading review activity…
        </div>
      )}
    </section>
  );
}
