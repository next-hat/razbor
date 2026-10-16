"use client";

import Link from "next/link.js";
import { useState } from "react";
import { ArrowRight, GitPullRequest, Search } from "lucide-react";

import type { PullRequestView } from "@razbor/database";

import { PullRequestRefresh } from "@web/components/pull-request-refresh.js";
import { PullRequestTable } from "@web/components/pull-request-table.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@web/components/ui/empty.js";
import { Input } from "@web/components/ui/input.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import { usePullRequests } from "@web/lib/use-pull-requests.js";
import { cn } from "@web/lib/utils.js";

/** Refreshes a repository's pull requests with compact filters, provider warnings, or an overview preview. */
export function RepositoryPullRequests({
  id,
  initialData,
  summaryOnly = false,
}: Readonly<{
  id: string;
  initialData?: PullRequestView[];
  summaryOnly?: boolean;
}>) {
  const snapshot = usePullRequests<PullRequestView[]>(
    "/api/pull-requests",
    initialData,
  );
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const pullRequests = snapshot.data?.filter((pr) => pr.repositoryId === id);
  const visible = pullRequests?.filter(
    (pr) =>
      (state === "all" || pr.state === state) &&
      (!query ||
        pr.title.toLowerCase().includes(query) ||
        String(pr.number).includes(query.replace(/^#/, ""))),
  );
  const title = summaryOnly ? "Open pull requests" : "Pull requests";
  return (
    <section
      aria-labelledby="repository-pull-requests"
      className={cn(
        "flex min-w-0 flex-col gap-4",
        summaryOnly && "console-card overview-pull-requests",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="repository-pull-requests" className="text-base font-semibold">
            {title}
            {summaryOnly && pullRequests && (
              <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
                {visible?.length}
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {summaryOnly
              ? "Changes waiting for human review."
              : "Saved changes from this repository, including their latest automated review."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PullRequestRefresh
            refreshing={snapshot.refreshing}
            refresh={snapshot.refresh}
          />
          {summaryOnly && (
            <Link
              href={`/repos/${id}/pull-requests`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              View pull requests
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
      {!summaryOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Pull request state"
          >
            {(["open", "closed", "all"] as const).map((filter) => (
              <Button
                key={filter}
                variant={state === filter ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={state === filter}
                onClick={() => setState(filter)}
              >
                <span className="capitalize">{filter}</span>
                <span className="tabular-nums text-muted-foreground">
                  {pullRequests?.filter(
                    (pr) => filter === "all" || pr.state === filter,
                  ).length ?? "—"}
                </span>
              </Button>
            ))}
          </div>
          <div className="relative w-full sm:max-w-xs">
            <label htmlFor="repository-pr-search" className="sr-only">
              Search pull requests
            </label>
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="repository-pr-search"
              type="search"
              placeholder="Search title or #number…"
              className="pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
      )}
      {(snapshot.warning || snapshot.error) && (
        <Alert>
          <AlertDescription>
            {snapshot.warning ||
              "Saved pull requests are unavailable. Retrying…"}
          </AlertDescription>
        </Alert>
      )}
      {!pullRequests ? (
        !snapshot.error && <Skeleton className="h-40 w-full" />
      ) : visible?.length ? (
        <PullRequestTable
          pullRequests={summaryOnly ? visible.slice(0, 5) : visible}
          showState={!summaryOnly}
        />
      ) : (
        <Empty className="rounded-lg border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitPullRequest />
            </EmptyMedia>
            <EmptyTitle>
              {query
                ? "No matching pull requests"
                : snapshot.refreshing
                  ? "Checking repository pull requests…"
                  : state === "open"
                    ? "No open pull requests"
                    : "No pull requests here yet"}
            </EmptyTitle>
            <EmptyDescription>
              {query
                ? "Try another title or pull request number."
                : snapshot.warning
                  ? "This saved snapshot may be out of date. Refresh to check the current forge state."
                  : "Pull requests appear here after a successful refresh from your forge."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}
