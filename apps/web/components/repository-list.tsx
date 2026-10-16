"use client";

import Link from "next/link.js";
import {
  GitBranch,
  GitPullRequest,
  LayoutDashboard,
  Settings2,
} from "lucide-react";

import type { listRepositories } from "@razbor/database";

import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@web/components/ui/empty.js";
import { formatUtc } from "@web/lib/date.js";

type Repository = Awaited<ReturnType<typeof listRepositories>>[number];

export type RepositoryCardMetrics = {
  pullRequests?: number;
  indexedAt?: string | null;
  indexState?: string;
};

/**
 * Shows authorized live preparation and durable index state, falling back to
 * the recorded initial index. Local repository deletion takes precedence.
 */
function RepositorySetupBadge({
  repo,
  indexState,
}: Readonly<{ repo: Repository; indexState?: string }>) {
  if (repo.status === "deleting")
    return <Badge variant="secondary">Deleting</Badge>;
  const indexLabels: Record<
    string,
    {
      label: string;
      variant: "success" | "warning" | "secondary" | "destructive";
    }
  > = {
    ready: { label: "Indexed", variant: "success" },
    indexing: { label: "Indexing", variant: "warning" },
    error: { label: "Index needs attention", variant: "destructive" },
    unready: { label: "Refresh required", variant: "warning" },
    "not-provisioned": { label: "Not indexed", variant: "secondary" },
    "on-demand": { label: "Not indexed", variant: "secondary" },
    expired: { label: "Expired", variant: "secondary" },
    deleting: { label: "Removing", variant: "secondary" },
  };
  const index = indexState ? indexLabels[indexState] : undefined;
  if (index)
    return (
      <Badge variant={index.variant}>
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
        {index.label}
      </Badge>
    );
  const labels = {
    error: "Setup needs attention",
    indexing: "Indexing",
    pending: "Setup pending",
    ready: "Initial index ready",
  };
  return (
    <Badge
      variant={
        repo.setupState === "error"
          ? "destructive"
          : repo.setupState === "ready"
            ? "success"
            : repo.setupState === "indexing"
              ? "warning"
              : "secondary"
      }
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {labels[repo.setupState]}
    </Badge>
  );
}

/**
 * Distinguishes a pending verification from a connected repository or local deletion in
 * progress.
 */
function connectionLabel(repo: Repository) {
  if (repo.status === "deleting") return "Removing local data";
  return repo.verifiedAt ? "Connected to forge" : "Awaiting verification";
}

/**
 * Lists accessible repository reviews, adding setup state, assigned reviewers, and
 * settings navigation for administrators.
 */
export function RepositoryList({
  repositories,
  isAdmin = false,
  view = "grid",
  metrics,
}: Readonly<{
  repositories: Awaited<ReturnType<typeof listRepositories>>;
  isAdmin?: boolean;
  view?: "grid" | "list";
  metrics?: Record<string, RepositoryCardMetrics>;
}>) {
  if (!repositories.length)
    return (
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyTitle>
            {isAdmin
              ? "No repositories configured"
              : "No repository access yet"}
          </EmptyTitle>
          <EmptyDescription>
            {isAdmin
              ? "Use Connect repository to connect an existing project on your forge."
              : "An administrator can give your account access to repositories."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="repository-collection" data-view={view}>
      {repositories.map((repo) => {
        const name = repo.metadata?.fullPath ?? repo.selector ?? repo.configKey;
        const detailHref =
          isAdmin && repo.status === "deleting"
            ? `/repos/${repo.id}/settings`
            : `/repos/${repo.id}`;
        const snapshot = metrics?.[repo.id];
        const indexedAt =
          snapshot?.indexedAt && !Number.isNaN(Date.parse(snapshot.indexedAt))
            ? snapshot.indexedAt
            : undefined;
        return (
          <article
            key={repo.id}
            className="repository-card flex min-w-0 flex-col rounded-lg border bg-card"
            aria-labelledby={`repository-${repo.id}-title`}
          >
            <div className="repository-card-header flex min-w-0 items-start gap-3 p-4 pb-0">
              <span className="repository-card-icon" aria-hidden="true">
                <GitBranch />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h2
                    id={`repository-${repo.id}-title`}
                    className="repository-card-title"
                  >
                    <Link href={detailHref}>{name}</Link>
                  </h2>
                  {repo.metadata?.visibility && (
                    <Badge variant="outline" className="capitalize">
                      {repo.metadata.visibility}
                    </Badge>
                  )}
                </div>
                <p className="repository-card-branch">
                  {repo.branch ??
                    repo.metadata?.defaultBranch ??
                    "Configured branch"}
                </p>
              </div>
            </div>
            {isAdmin && (
              <div className="repository-card-metadata flex min-w-0 flex-col gap-1 px-4 pt-3">
                <p>{connectionLabel(repo)}</p>
                <p>Reviewer: {repo.agent?.model ?? "Runner default"}</p>
              </div>
            )}
            {snapshot?.pullRequests !== undefined && (
              <div className="repository-card-metrics px-4 pt-4">
                <Link
                  href={`/repos/${repo.id}/pull-requests`}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <GitPullRequest className="size-3.5" aria-hidden="true" />
                  Open pull requests
                  <span className="ml-auto font-semibold tabular-nums text-foreground">
                    {snapshot.pullRequests.toLocaleString("en-US")}
                  </span>
                </Link>
              </div>
            )}
            {isAdmin && (
              <div className="repository-card-status flex flex-wrap items-center gap-2 px-4 pt-4">
                <RepositorySetupBadge
                  repo={repo}
                  indexState={snapshot?.indexState}
                />
                {indexedAt && (
                  <p className="repository-card-index-date">
                    Last indexed{" "}
                    <time dateTime={indexedAt}>{formatUtc(indexedAt)}</time>
                  </p>
                )}
              </div>
            )}
            <div className="repository-card-footer mt-auto flex flex-wrap items-center justify-between gap-2 p-4 pt-4">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={`/repos/${repo.id}`} />}
              >
                <LayoutDashboard data-icon="inline-start" aria-hidden="true" />
                Overview
              </Button>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={`/repos/${repo.id}/settings`} />}
                >
                  <Settings2 data-icon="inline-start" aria-hidden="true" />
                  Settings
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
