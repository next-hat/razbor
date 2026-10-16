"use client";

import Link from "next/link.js";
import { useState } from "react";
import {
  CalendarDays,
  CircleCheck,
  Clock3,
  GitPullRequest,
  GitPullRequestClosed,
  Search,
  type LucideIcon,
} from "lucide-react";

import type { PullRequestView } from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import { PullRequestTable } from "@web/components/pull-request-table.js";
import { PullRequestRefresh } from "@web/components/pull-request-refresh.js";
import { formatUtc } from "@web/lib/date.js";
import { usePullRequests } from "@web/lib/use-pull-requests.js";
import { cn } from "@web/lib/utils.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@web/components/ui/empty.js";
import { Field, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { Skeleton } from "@web/components/ui/skeleton.js";

const filters = ["open", "closed", "all"] as const;

/** Counts completed automation for the current head, also checking the provider base when recorded. */
function hasCurrentCompletedReview(pr: PullRequestView) {
  const review = pr.latestReview;
  return (
    review?.status === "completed" &&
    review.headSha === pr.headSha &&
    (!review.targetBaseSha || review.targetBaseSha === pr.baseSha)
  );
}

/** Returns the newest valid provider-sync timestamp in the saved snapshot, omitting unavailable timestamps. */
function latestPullRequestSync(pullRequests: PullRequestView[] | undefined) {
  let latest: string | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const pr of pullRequests ?? []) {
    const timestamp = Date.parse(pr.syncedAt);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latest = pr.syncedAt;
      latestTimestamp = timestamp;
    }
  }
  return latest;
}

/** Presents a saved queue count and keeps its explanation aligned to the bottom of the card. */
function PullRequestSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: Readonly<{
  label: string;
  value: number | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
}>) {
  return (
    <div className="flex min-h-24 min-w-0 gap-3 rounded-lg border bg-card p-4">
      <span
        className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
        data-tone={tone}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
        <p className="mt-1 break-all text-2xl font-semibold tracking-tight tabular-nums">
          {value?.toLocaleString("en-US") ?? "—"}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** Presents the human review queue and searchable saved PR history across accessible repositories. */
export default function PullRequestsPage({
  initialData,
  state = "open",
}: Readonly<{
  initialData?: PullRequestView[];
  state?: (typeof filters)[number];
}>) {
  const prs = usePullRequests<PullRequestView[]>(
    "/api/pull-requests",
    initialData,
  );
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const openPullRequests = prs.data?.filter((pr) => pr.state === "open");
  const counts = {
    open: openPullRequests?.length,
    closed: prs.data?.filter((pr) => pr.state === "closed").length,
    all: prs.data?.length,
  };
  const automatedComplete = openPullRequests?.filter(
    hasCurrentCompletedReview,
  ).length;
  const awaitingAutomation =
    counts.open !== undefined && automatedComplete !== undefined
      ? counts.open - automatedComplete
      : undefined;
  const lastSync = latestPullRequestSync(prs.data);
  const visible = prs.data?.filter(
    (pr) =>
      (state === "all" || pr.state === state) &&
      `${pr.title} ${pr.repositoryName} #${pr.number} ${pr.author ?? ""}`
        .toLowerCase()
        .includes(query),
  );
  return (
    <main className="console-hero-page pull-requests-page flex min-w-0 flex-col">
      <ConsoleHero
        id="pull-requests-title"
        eyebrow="Pull requests"
        title="Pull requests"
        description="Review the changes waiting to merge. Automated findings and review history stay with each pull request."
      >
        <Badge variant="outline" className="h-7 gap-1.5 px-2 text-xs">
          <span aria-hidden="true" className="size-2 rounded-full bg-success" />
          <span className="tabular-nums">{counts.open ?? "—"} open</span>
        </Badge>
        <Badge variant="outline" className="h-7 gap-1.5 px-2 text-xs">
          <span
            aria-hidden="true"
            className="size-2 rounded-full border-2 border-muted-foreground"
          />
          <span className="tabular-nums">{counts.closed ?? "—"} closed</span>
        </Badge>
        {lastSync && (
          <span className="flex min-h-7 items-center gap-2 text-xs font-medium text-muted-foreground">
            <CalendarDays aria-hidden="true" className="size-3.5 shrink-0" />
            Last sync {formatUtc(lastSync)}
          </span>
        )}
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        {(prs.warning || prs.error) && (
          <Alert>
            <AlertDescription>
              {prs.warning || "Saved pull requests are unavailable. Retrying…"}
            </AlertDescription>
          </Alert>
        )}
        <section
          aria-label="Pull request totals"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <PullRequestSummaryCard
            label="Open pull requests"
            value={counts.open}
            detail="Waiting for human review"
            icon={GitPullRequest}
            tone="findings"
          />
          <PullRequestSummaryCard
            label="Automated review complete"
            value={automatedComplete}
            detail="Current head · open requests"
            icon={CircleCheck}
            tone="success"
          />
          <PullRequestSummaryCard
            label="Awaiting automated review"
            value={awaitingAutomation}
            detail="Open requests"
            icon={Clock3}
            tone="findings"
          />
          <PullRequestSummaryCard
            label="Total pull requests"
            value={counts.all}
            detail={`${counts.open ?? "—"} open · ${counts.closed ?? "—"} closed`}
            icon={GitPullRequestClosed}
            tone="tokens"
          />
        </section>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <nav aria-label="Pull request state" className="flex gap-4">
            {filters.map((filter) => (
              <Link
                key={filter}
                href={`/pull-requests?state=${filter}`}
                aria-current={state === filter ? "page" : undefined}
                className={cn(
                  "flex min-h-8 items-center gap-2 border-b-2 border-transparent text-sm capitalize text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  state === filter &&
                    "border-primary font-medium text-foreground",
                )}
              >
                {filter}
                <span className="text-xs tabular-nums">
                  {counts[filter] ?? "—"}
                </span>
              </Link>
            ))}
          </nav>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <Field className="min-w-0 flex-1 sm:w-80 lg:w-92">
              <FieldLabel htmlFor="pr-search" className="sr-only">
                Search pull requests
              </FieldLabel>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="pr-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search title, repository or #number…"
                  className="pl-9"
                />
              </div>
            </Field>
            <PullRequestRefresh
              refreshing={prs.refreshing}
              refresh={prs.refresh}
            />
          </div>
        </div>
        {!prs.data ? (
          !prs.error && <Skeleton className="h-64 w-full" />
        ) : visible?.length ? (
          <PullRequestTable pullRequests={visible} showState />
        ) : (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitPullRequest />
              </EmptyMedia>
              <EmptyTitle>
                {query
                  ? "No matching pull requests"
                  : prs.refreshing
                    ? "Checking connected repositories…"
                    : state === "open"
                      ? "No open pull requests"
                      : "No pull requests here yet"}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another title, repository or pull request number."
                  : "Pull requests from your connected repositories appear here after a successful refresh."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <p className="text-xs text-muted-foreground">
          Open pull requests stay in the human review queue even after an
          automated review is complete.
        </p>
      </div>
    </main>
  );
}
