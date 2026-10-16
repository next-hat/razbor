"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { useState } from "react";
import {
  Clock3,
  Database,
  FolderGit2,
  LayoutGrid,
  List,
  Plus,
  Search,
} from "lucide-react";

import type { IndexPreparation } from "@razbor/contracts";
import type {
  listIndexProjects,
  listRepositories,
  PullRequestView,
} from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import {
  RepositoryList,
  type RepositoryCardMetrics,
} from "@web/components/repository-list.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import { Input } from "@web/components/ui/input.js";
import { Field, FieldLabel } from "@web/components/ui/field.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@web/components/ui/empty.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import { formatUtc } from "@web/lib/date.js";
import { usePoll } from "@web/lib/use-poll.js";

type Repository = Awaited<ReturnType<typeof listRepositories>>[number];

type RepositoryIndex = Awaited<ReturnType<typeof listIndexProjects>>[number] & {
  preparation?: IndexPreparation | null;
};

type SavedPullRequest = Pick<PullRequestView, "repositoryId" | "state">;

/** Resolves the same display path used by repository cards and the server list. */
function repositoryName(repository: Repository) {
  return (
    repository.metadata?.fullPath ?? repository.selector ?? repository.configKey
  );
}

/** Sorts unavailable publication dates after recorded indexes. */
function indexTimestamp(indexedAt?: string | null) {
  const timestamp = indexedAt ? Date.parse(indexedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Keeps live preparation activity or failure visible over a previously published index. */
function repositoryIndexState(index?: RepositoryIndex) {
  if (!index || ["deleting", "expired"].includes(index.state))
    return index?.state;
  if (index.preparation?.state === "error") return "error";
  if (
    index.preparation?.state === "queued" ||
    index.preparation?.state === "running"
  )
    return "indexing";
  return index.state;
}

/** Presents accessible project cards with URL-backed sorting and view selection. */
export function RepositoriesPage({
  initialData,
  initialIndexes,
  initialPullRequests,
  isAdmin = false,
  canReadIndexes = false,
  sort = "name",
  view = "grid",
}: Readonly<{
  initialData?: Repository[];
  initialIndexes?: RepositoryIndex[];
  initialPullRequests?: SavedPullRequest[];
  isAdmin?: boolean;
  canReadIndexes?: boolean;
  sort?: "name" | "name-desc" | "indexed";
  view?: "grid" | "list";
}>) {
  const router = useRouter();
  const { data, error } = usePoll<Repository[]>(
    "/api/repositories",
    initialData,
  );
  const [initialIndexSnapshot] = useState(() =>
    initialIndexes ? { projects: initialIndexes } : undefined,
  );
  const indexes = usePoll<{ projects: RepositoryIndex[] }>(
    canReadIndexes ? "/api/indexes" : null,
    initialIndexSnapshot,
    15_000,
  );
  const pullRequests = usePoll<SavedPullRequest[]>(
    "/api/pull-requests",
    initialPullRequests,
    15_000,
  );
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const metrics: Record<string, RepositoryCardMetrics> = {};
  for (const repository of data ?? []) {
    const index = canReadIndexes
      ? indexes.data?.projects.find(
          (entry) => entry.repositoryId === repository.id,
        )
      : undefined;
    metrics[repository.id] = {
      pullRequests: pullRequests.data?.filter(
        (entry) =>
          entry.repositoryId === repository.id && entry.state === "open",
      ).length,
      indexState: repositoryIndexState(index),
      indexedAt: index?.indexedAt,
    };
  }
  const visible = data
    ?.filter((repository) =>
      repositoryName(repository).toLowerCase().includes(query),
    )
    .sort((a, b) => {
      if (sort === "indexed" && canReadIndexes) {
        const difference =
          indexTimestamp(metrics[b.id]?.indexedAt) -
          indexTimestamp(metrics[a.id]?.indexedAt);
        if (difference) return difference;
      }
      const difference = repositoryName(a).localeCompare(repositoryName(b));
      return sort === "name-desc" ? -difference : difference;
    });
  const indexed = canReadIndexes
    ? indexes.data
      ? data?.filter(
          (repository) =>
            repository.status === "active" &&
            metrics[repository.id]?.indexState === "ready",
        ).length
      : undefined
    : data?.filter(
        (repository) =>
          repository.status === "active" && repository.setupState === "ready",
      ).length;
  const lastIndexed = data?.reduce<string | undefined>((latest, repository) => {
    const date = metrics[repository.id]?.indexedAt;
    return indexTimestamp(date) > indexTimestamp(latest)
      ? (date ?? latest)
      : latest;
  }, undefined);
  const sortItems = [
    ...(canReadIndexes ? [{ label: "Last indexed", value: "indexed" }] : []),
    { label: "Name A–Z", value: "name" },
    { label: "Name Z–A", value: "name-desc" },
  ];

  return (
    <main className="console-hero-page repositories-page flex min-w-0 flex-col">
      <ConsoleHero
        id="repositories-title"
        eyebrow="Repositories"
        title="Repositories"
        description={
          isAdmin
            ? "Your connected projects, review activity, and indexing settings."
            : "Review activity for the repositories you can access."
        }
      >
        <span className="console-hero-status">
          <FolderGit2 className="size-4" aria-hidden="true" />
          <span className="tabular-nums">
            {data?.length ?? "—"} repositories
          </span>
        </span>
        {isAdmin && (
          <span className="console-hero-status">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${indexed ? "bg-success" : "bg-muted-foreground"}`}
            />
            <span className="tabular-nums">
              {indexed ?? "—"}{" "}
              {canReadIndexes ? "indexed" : "initial indexes ready"}
            </span>
          </span>
        )}
        {canReadIndexes && lastIndexed && (
          <span className="console-hero-status">
            <Clock3 className="size-4" aria-hidden="true" />
            Last indexed {formatUtc(lastIndexed)}
          </span>
        )}
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        {(error || indexes.error || pullRequests.error) && (
          <Alert variant="destructive">
            <AlertDescription>
              Some repository data is unavailable. Retrying…
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Field className="w-full min-w-0 sm:max-w-sm">
            <FieldLabel htmlFor="repository-search" className="sr-only">
              Find a repository
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="repository-search"
                type="search"
                placeholder="Find a repository…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
              />
            </div>
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                id="repository-sort-label"
                className="text-xs text-muted-foreground"
              >
                Sort by
              </span>
              <Select
                items={sortItems}
                value={sort}
                onValueChange={(value) => {
                  if (value)
                    router.replace(`/repos?sort=${value}&view=${view}`, {
                      scroll: false,
                    });
                }}
              >
                <SelectTrigger
                  aria-labelledby="repository-sort-label"
                  className="min-w-36"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sortItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div
              role="group"
              aria-label="Repository view"
              className="flex gap-1 rounded-lg border p-0.5"
            >
              <Button
                variant={view === "list" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="List view"
                aria-current={view === "list" ? "true" : undefined}
                nativeButton={false}
                render={
                  <Link href={`/repos?sort=${sort}&view=list`} scroll={false} />
                }
              >
                <List aria-hidden="true" />
              </Button>
              <Button
                variant={view === "grid" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Grid view"
                aria-current={view === "grid" ? "true" : undefined}
                nativeButton={false}
                render={
                  <Link href={`/repos?sort=${sort}&view=grid`} scroll={false} />
                }
              >
                <LayoutGrid aria-hidden="true" />
              </Button>
            </div>
            {isAdmin && (
              <Link
                href="/repos/new"
                className={buttonVariants({
                  size: "sm",
                })}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                Connect repository
              </Link>
            )}
          </div>
        </div>
        {!visible ? (
          !error && <Skeleton className="h-64 w-full" />
        ) : query && !visible.length ? (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>No matching repositories</EmptyTitle>
              <EmptyDescription>
                No repositories match “{search}”. Try another name.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : visible.length ? (
          <RepositoryList
            repositories={visible}
            isAdmin={isAdmin}
            view={view}
            metrics={metrics}
          />
        ) : !isAdmin ? (
          <RepositoryList repositories={[]} />
        ) : null}
        {isAdmin && data && !data.length && (
          <Empty className="gap-4 border bg-card/50 py-6">
            <EmptyHeader className="max-w-2xl">
              <EmptyMedia variant="icon" className="border">
                <Database />
              </EmptyMedia>
              <EmptyTitle className="text-base font-semibold">
                Connect your first repository
              </EmptyTitle>
              <EmptyDescription>
                Link a repository from GitHub, GitLab or Forgejo to enable
                automated code review.
              </EmptyDescription>
            </EmptyHeader>
            <Link
              href="/repos/new"
              className={buttonVariants({
                size: "sm",
              })}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Connect repository
            </Link>
          </Empty>
        )}
      </div>
    </main>
  );
}
