"use client";

import { useState } from "react";
import {
  Activity,
  CircleCheck,
  Clock3,
  GitBranch,
  RefreshCw,
  Search,
  Server,
  Unplug,
  type LucideIcon,
} from "lucide-react";

import type { RunnerView } from "@razbor/contracts";

import { ConsoleHero } from "@web/components/console-hero.js";
import { RunnerForm } from "@web/components/runner-form.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@web/components/ui/empty.js";
import { Field, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@web/components/ui/table.js";
import { formatUtc } from "@web/lib/date.js";
import type { runnerData } from "@web/lib/runners.js";
import { usePoll } from "@web/lib/use-poll.js";
import { cn } from "@web/lib/utils.js";

const labels: Record<RunnerView["status"], string> = {
  pending: "Not enrolled",
  offline: "Offline",
  online: "Ready",
  busy: "Busy",
  unhealthy: "Runtime unavailable",
  incompatible: "Update required",
  revoked: "Revoked",
  draining: "Draining",
};

/** Identifies statuses emitted only after the server verifies an unexpired runner session. */
function isConnectedRunner(runner: RunnerView) {
  return ["online", "busy", "draining", "unhealthy", "incompatible"].includes(
    runner.status,
  );
}

/** Resolves granted repository names, including current repositories for runners with all-repository access. */
function runnerRepositoryNames(
  runner: RunnerView,
  repositories: ReadonlyMap<string, string>,
) {
  return runner.allRepositories
    ? ["All repositories, including future ones", ...repositories.values()]
    : runner.repositoryIds.map((id) => repositories.get(id) ?? id);
}

/** Presents a recorded count or timestamp with its explanation anchored to the card's bottom. */
function RunnerSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
  valueTitle,
}: Readonly<{
  label: string;
  value: number | string | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
  valueTitle?: string;
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
        <p
          className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums"
          title={valueTitle}
        >
          {typeof value === "number"
            ? value.toLocaleString("en-US")
            : (value ?? "—")}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** Maps recorded runner health to a badge, showing unknown status when polling fails. */
function RunnerStatus({
  runner,
  stale,
}: Readonly<{ runner: RunnerView; stale: boolean }>) {
  return (
    <Badge
      className="h-auto min-h-5 max-w-full text-left whitespace-normal"
      variant={
        stale
          ? "outline"
          : runner.status === "online"
            ? "success"
            : runner.status === "busy"
              ? "info"
              : ["unhealthy", "incompatible", "revoked"].includes(runner.status)
                ? "warning"
                : "outline"
      }
    >
      {stale ? "Unknown" : labels[runner.status]}
    </Badge>
  );
}

/** Refreshes runner availability and grants while preserving saved facts and disabling management during polling failures. */
export function RunnersPage({
  initialData,
}: Readonly<{ initialData?: Awaited<ReturnType<typeof runnerData>> }>) {
  const { data, error, setData } = usePoll("/api/runners", initialData);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const online =
    data && !error ? data.runners.filter(isConnectedRunner).length : undefined;
  const offline =
    data && !error
      ? data.runners.filter((runner) => runner.status === "offline").length
      : undefined;
  const repositoryNames = new Map(
    data?.repositories.map((repository) => [repository.id, repository.name]),
  );
  const query = search.trim().toLowerCase();
  const visibleRunners = data?.runners.filter((runner) =>
    `${runner.name} ${runnerRepositoryNames(runner, repositoryNames).join(" ")}`
      .toLowerCase()
      .includes(query),
  );
  const snapshotDate = data ? new Date(data.asOf) : undefined;
  const snapshotTimestamp =
    snapshotDate && Number.isFinite(snapshotDate.getTime())
      ? snapshotDate.toISOString()
      : undefined;

  /** Merges an accepted mutation into the saved snapshot and announces the successful save. */
  function saved(runner: RunnerView) {
    setData((current) =>
      current
        ? {
            ...current,
            runners: current.runners.some((item) => item.id === runner.id)
              ? current.runners.map((item) =>
                  item.id === runner.id ? runner : item,
                )
              : [...current.runners, runner],
          }
        : current,
    );
    setNotice(`${runner.name} saved.`);
  }

  return (
    <main className="console-hero-page runners-page flex min-w-0 flex-col">
      <ConsoleHero
        id="runners-title"
        eyebrow="Review execution hosts"
        title="Runners"
        description="Register execution hosts and choose which repositories they can review."
      >
        <span className="console-hero-status">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full",
              error || !online ? "bg-muted-foreground" : "bg-success",
            )}
          />
          <span className="tabular-nums">{online ?? "—"} online</span>
        </span>
        <span className="console-hero-status">
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
          Refreshes every 3 seconds
        </span>
      </ConsoleHero>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section
          aria-label="Runner totals"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <RunnerSummaryCard
            label="Total runners"
            value={data?.runners.length}
            detail="Registered execution hosts"
            icon={Server}
            tone="findings"
          />
          <RunnerSummaryCard
            label="Online"
            value={online}
            detail="Connected to razbor"
            icon={CircleCheck}
            tone="success"
          />
          <RunnerSummaryCard
            label="Offline"
            value={offline}
            detail="Enrolled hosts without a live session"
            icon={Unplug}
            tone="info"
          />
          <RunnerSummaryCard
            label="Last updated"
            value={
              snapshotTimestamp
                ? `${snapshotTimestamp.slice(11, 16)} UTC`
                : undefined
            }
            detail={
              snapshotTimestamp
                ? `${snapshotTimestamp.slice(0, 10)} · ${error ? "Saved snapshot" : "Snapshot time"}`
                : "Snapshot time unavailable"
            }
            valueTitle={
              snapshotTimestamp ? formatUtc(snapshotTimestamp) : undefined
            }
            icon={Clock3}
            tone="tokens"
          />
        </section>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              Unable to refresh runners. Retrying…
              {data &&
                " Showing the last successful snapshot. Availability and current activity are unknown; management is disabled until refresh succeeds."}
            </AlertDescription>
          </Alert>
        )}
        <div className="runners-toolbar flex flex-wrap items-center justify-between gap-4">
          <Field className="w-full min-w-0 sm:max-w-md">
            <FieldLabel htmlFor="runner-search" className="sr-only">
              Search runners
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="runner-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search runner or repository…"
                disabled={!data}
                className="pl-9"
              />
            </div>
          </Field>
          <RunnerForm
            disabled={!data || error}
            repositories={data?.repositories ?? []}
            onSaved={saved}
          />
        </div>
        {!data ? (
          !error && (
            <div role="status">
              <span className="sr-only">Loading runners…</span>
              <Skeleton className="h-64 w-full" />
            </div>
          )
        ) : visibleRunners?.length ? (
          <div className="runners-table overflow-hidden rounded-lg border bg-card">
            <Table aria-label="Registered runners">
              <TableHeader>
                <TableRow>
                  <TableHead className="runners-identity-cell">
                    Runner / repositories
                  </TableHead>
                  <TableHead className="runners-status-cell">Status</TableHead>
                  <TableHead className="runners-version-cell">
                    Version
                  </TableHead>
                  <TableHead className="runners-seen-cell">Last seen</TableHead>
                  <TableHead className="runners-activity-cell">
                    Activity
                  </TableHead>
                  <TableHead className="runners-actions-cell">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRunners.map((runner) => (
                  <TableRow key={runner.id}>
                    <TableCell
                      className="runners-identity-cell"
                      data-label="Runner / repositories"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
                          <Server aria-hidden="true" className="size-5" />
                        </span>
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="break-all font-semibold">
                            {runner.name}
                          </span>
                          <span className="break-all text-xs leading-relaxed text-muted-foreground">
                            {runner.allRepositories
                              ? "All repositories, including future ones"
                              : runner.repositoryIds.length
                                ? runnerRepositoryNames(
                                    runner,
                                    repositoryNames,
                                  ).join(", ")
                                : "No repositories assigned"}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell
                      className="runners-status-cell"
                      data-label="Status"
                    >
                      <RunnerStatus runner={runner} stale={error} />
                    </TableCell>
                    <TableCell
                      className="runners-version-cell"
                      data-label="Version"
                    >
                      <span className="break-all text-xs text-muted-foreground">
                        {runner.runtimeVersion ?? "Not reported"}
                      </span>
                    </TableCell>
                    <TableCell
                      className="runners-seen-cell"
                      data-label="Last seen"
                    >
                      <span className="text-xs text-muted-foreground">
                        {runner.lastSeenAt ? (
                          <time dateTime={runner.lastSeenAt}>
                            {formatUtc(runner.lastSeenAt)}
                          </time>
                        ) : (
                          "Awaiting first connection"
                        )}
                      </span>
                    </TableCell>
                    <TableCell
                      className="runners-activity-cell"
                      data-label="Activity"
                    >
                      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                        <span className="font-medium tabular-nums text-foreground">
                          {error
                            ? "Unknown"
                            : `${runner.activeReviews} / ${runner.capacity}`}
                        </span>
                        <span>Active reviews / capacity</span>
                      </div>
                    </TableCell>
                    <TableCell
                      className="runners-actions-cell"
                      data-label="Actions"
                    >
                      <RunnerForm
                        runner={runner}
                        repositories={data.repositories}
                        disabled={error}
                        onSaved={saved}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query ? <Search /> : <Server />}
              </EmptyMedia>
              <EmptyTitle>
                {query ? "No matching runners" : "No runners registered"}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another runner name or assigned repository."
                  : "Register a host to get a one-time enrollment command. Assign repositories here when they are ready."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <section
          aria-labelledby="about-runners"
          className="flex flex-col gap-5 rounded-lg border bg-card p-5"
        >
          <div>
            <h2 id="about-runners" className="text-lg font-semibold">
              About runners
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Execution hosts connect to razbor and run automated reviews for
              assigned repositories.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="flex items-start gap-3">
              <Server
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div>
                <h3 className="text-sm font-medium">Host enrollment</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Register a host to receive its one-time enrollment command.
                  Offline runners and their repository assignments remain saved.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <GitBranch
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div>
                <h3 className="text-sm font-medium">Repository access</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Only assigned repositories can send work to a runner. Reviews
                  wait for available capacity and a configured AI reviewer.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Activity
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div>
                <h3 className="text-sm font-medium">
                  Availability and readiness
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Online counts connected sessions, including busy or draining
                  runners and hosts whose runtime is unavailable or needs an
                  update. Ready means the runtime is available and the runner
                  has capacity for another review.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
