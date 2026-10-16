import Link from "next/link.js";
import {
  GitPullRequest,
  GitPullRequestClosed,
  ChevronRight,
} from "lucide-react";

import type { PullRequestView } from "@razbor/database";

import { Status } from "@web/components/status.js";
import { Badge } from "@web/components/ui/badge.js";
import { buttonVariants } from "@web/components/ui/button.js";
import { formatUtc } from "@web/lib/date.js";
import { cn } from "@web/lib/utils.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table.js";

/** Identifies the latest automated run and warns when either captured branch revision has changed. */
function PullRequestReviewStatus({ pr }: Readonly<{ pr: PullRequestView }>) {
  return (
    <>
      {pr.latestReview ? (
        <Status value={pr.latestReview.status} />
      ) : (
        <span className="text-xs text-muted-foreground">Not reviewed</span>
      )}
      {pr.latestReview &&
        (pr.latestReview.headSha !== pr.headSha ||
          (pr.latestReview.targetBaseSha &&
            pr.latestReview.targetBaseSha !== pr.baseSha)) && (
          <span className="block text-xs text-warning">Earlier revision</span>
        )}
    </>
  );
}

/** Shows a result count, distinguishing an absent result from a completed review with no findings. */
function PullRequestFindingCount({
  pr,
  withLabel = false,
}: Readonly<{ pr: PullRequestView; withLabel?: boolean }>) {
  const result = pr.latestReview?.review;
  return result ? (
    <span
      className={cn(
        "font-medium tabular-nums",
        result.findings.length > 0 && "text-warning",
      )}
    >
      {result.findings.length}
      {withLabel && ` finding${result.findings.length === 1 ? "" : "s"}`}
    </span>
  ) : (
    <span className="text-muted-foreground" aria-label="No review result">
      {withLabel ? "No result yet" : "—"}
    </span>
  );
}

/**
 * Lists PR identity, optional provider state, captured automated review status and findings together.
 * A completed automated review never removes a PR from the human review queue.
 */
export function PullRequestTable({
  pullRequests,
  showState = false,
}: Readonly<{ pullRequests: PullRequestView[]; showState?: boolean }>) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-full">Pull request</TableHead>
            {showState && (
              <TableHead className="hidden md:table-cell">Status</TableHead>
            )}
            <TableHead className="hidden sm:table-cell">
              Automated review
            </TableHead>
            <TableHead className="hidden text-right sm:table-cell">
              Findings
            </TableHead>
            <TableHead className="hidden text-right xl:table-cell">
              Updated
            </TableHead>
            <TableHead>
              <span className="sr-only">Details</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pullRequests.map((pr) => {
            const Icon =
              pr.state === "open" ? GitPullRequest : GitPullRequestClosed;
            return (
              <TableRow key={pr.id}>
                <TableCell className="py-3">
                  <div className="flex items-start gap-3">
                    <Icon
                      aria-label={pr.state}
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        pr.state === "open"
                          ? "text-success"
                          : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0">
                      <Link
                        href={`/pull-requests/${pr.id}`}
                        className="break-words whitespace-normal font-semibold leading-5 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {pr.title}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <Link
                          href={`/repos/${pr.repositoryId}`}
                          className="hover:underline"
                        >
                          {pr.repositoryName}
                        </Link>
                        <span className="tabular-nums">#{pr.number}</span>
                        {pr.author && <span>by {pr.author}</span>}
                        <code>{pr.headSha.slice(0, 12)}</code>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs sm:hidden">
                        <span className="text-muted-foreground">
                          Automated:
                        </span>
                        <PullRequestReviewStatus pr={pr} />
                        <PullRequestFindingCount pr={pr} withLabel />
                      </div>
                    </div>
                  </div>
                </TableCell>
                {showState && (
                  <TableCell className="hidden md:table-cell">
                    <Badge
                      variant={pr.state === "open" ? "success" : "secondary"}
                      className="gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-current"
                      />
                      {pr.state === "open" ? "Open" : "Closed"}
                    </Badge>
                  </TableCell>
                )}
                <TableCell className="hidden sm:table-cell">
                  <PullRequestReviewStatus pr={pr} />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <PullRequestFindingCount pr={pr} />
                </TableCell>
                <TableCell className="hidden text-right text-xs text-muted-foreground xl:table-cell">
                  {formatUtc(pr.updatedAt)}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/pull-requests/${pr.id}`}
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "icon" }),
                      "text-muted-foreground",
                    )}
                    aria-label={`View ${pr.title}`}
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
