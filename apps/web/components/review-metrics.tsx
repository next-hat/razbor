"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  ChartNoAxesColumn,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CodeXml,
  Coins,
  Database,
  Gauge,
  GitCompareArrows,
  Info,
  RefreshCw,
  SearchCheck,
  Shield,
  type LucideIcon,
} from "lucide-react";

import type {
  RepositoryReviewMetrics,
  ReviewActivityDay,
  ReviewMetrics,
  ReviewMetricTotals,
  TargetReviewMetrics,
} from "@razbor/contracts";

import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button } from "@web/components/ui/button.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table.js";
import { usePoll } from "@web/lib/use-poll.js";
import { cn } from "@web/lib/utils.js";

const numberFormatter = new Intl.NumberFormat("en-US");

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
});

const heatColors = [
  "bg-muted ring-foreground/5",
  "bg-emerald-200 dark:bg-emerald-900 ring-emerald-950/10",
  "bg-emerald-400 dark:bg-emerald-700 ring-emerald-950/10",
  "bg-emerald-600 dark:bg-emerald-500 ring-emerald-950/10",
  "bg-emerald-800 dark:bg-emerald-300 ring-emerald-950/10",
];

const periods = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "all", label: "All time" },
];

type Breakdown = "repositories" | "changes" | "branches" | "revisions";

type HeatmapDay = ReviewActivityDay & { outsidePeriod: boolean };

/** Formats exact counts consistently across totals, activity, and breakdowns. */
function count(value: number) {
  return numberFormatter.format(value);
}

/** Converts measured review duration into a compact readable value; missing data stays unknown. */
function duration(value: number | null) {
  if (value === null) return "—";
  if (value < 1000) return "<1 s";
  if (value < 60_000) return `${Math.round(value / 1000)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

/** Formats a rate only when a meaningful denominator is available. */
function rate(numerator: number, denominator: number) {
  return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%` : "—";
}

/** Refreshes metrics and activity, optionally fixed to one repository, with supporting content and independent filter snapshots. */
export function ReviewMetricsPanel({
  initialMetrics,
  repositoryId: scopeRepositoryId,
  summaryOnly = false,
  children,
}: Readonly<{
  initialMetrics?: ReviewMetrics;
  repositoryId?: string;
  summaryOnly?: boolean;
  children?: ReactNode;
}>) {
  const catalogueUrl = scopeRepositoryId
    ? `/api/metrics?${new URLSearchParams({ repositoryId: scopeRepositoryId })}`
    : "/api/metrics";
  const catalogue = usePoll<ReviewMetrics>(
    catalogueUrl,
    initialMetrics,
    15_000,
  );
  const [repositoryId, setRepositoryId] = useState(scopeRepositoryId ?? "");
  const [targetKey, setTargetKey] = useState("");
  const [period, setPeriod] = useState("all");
  const query = new URLSearchParams();
  if (period !== "all") query.set("days", period);
  if (repositoryId) query.set("repositoryId", repositoryId);
  if (targetKey) query.set("targetKey", targetKey);
  const url = query.size ? `/api/metrics?${query}` : "/api/metrics";
  const targets =
    catalogue.data?.targets.filter(
      (row) =>
        row.repositoryId === repositoryId && row.target.kind !== "revision",
    ) ?? [];
  const selectedRepository = catalogue.data?.repositories.find(
    (row) => row.repositoryId === repositoryId,
  );
  const selectedTarget = targets.find((row) => row.target.key === targetKey);
  const scopeLabel = selectedTarget
    ? `${selectedRepository?.repositoryName ?? repositoryId} · ${selectedTarget.target.label}`
    : `${selectedRepository?.repositoryName ?? (repositoryId || "All repositories")}${targetKey ? ` · ${targetKey}` : ""}`;

  /** Changes the repository and discards the previous repository's target selection. */
  function selectRepository(nextRepositoryId: string) {
    setRepositoryId(scopeRepositoryId ?? nextRepositoryId);
    setTargetKey("");
  }

  /** Drills into one repository or one of its branch or forge change groups. */
  function selectScope(nextRepositoryId: string, nextTargetKey = "") {
    setRepositoryId(scopeRepositoryId ?? nextRepositoryId);
    setTargetKey(nextTargetKey);
  }

  if (summaryOnly) {
    return (
      <section aria-labelledby="review-metrics" className="flex flex-col gap-4">
        <h2 id="review-metrics" className="sr-only">
          Review metrics
        </h2>
        <MetricsSnapshot
          data={catalogue.data}
          error={catalogue.error}
          scopeLabel="All time"
          onSelectScope={selectScope}
          summaryOnly
        >
          {children}
        </MetricsSnapshot>
      </section>
    );
  }

  return (
    <section aria-labelledby="review-metrics" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="review-metrics" className="text-base font-semibold">
            Review metrics
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review activity, changed code, and finding outcomes.
          </p>
        </div>
        <div
          className="flex rounded-lg border bg-card p-1"
          aria-label="Reporting period"
        >
          {periods.map((option) => (
            <Button
              key={option.value}
              variant={period === option.value ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={period === option.value}
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        {!scopeRepositoryId && (
          <MetricFilter
            label="Repository"
            value={repositoryId}
            onChange={selectRepository}
          >
            <option value="">All repositories</option>
            {catalogue.data?.repositories.map((repository) => (
              <option
                key={repository.repositoryId}
                value={repository.repositoryId}
              >
                {repository.repositoryName}
              </option>
            ))}
          </MetricFilter>
        )}
        <MetricFilter
          label="Branch or pull / merge request"
          value={targetKey}
          onChange={setTargetKey}
          disabled={!repositoryId}
        >
          <option value="">
            {repositoryId ? "All targets" : "Choose a repository first"}
          </option>
          <optgroup label="Pull / merge requests">
            {targets
              .filter((row) => row.target.kind === "change")
              .map((row) => (
                <option key={row.target.key} value={row.target.key}>
                  {row.target.label}
                </option>
              ))}
          </optgroup>
          <optgroup label="Source branches">
            {targets
              .filter((row) => row.target.kind === "branch")
              .map((row) => (
                <option key={row.target.key} value={row.target.key}>
                  {row.target.label}
                </option>
              ))}
          </optgroup>
        </MetricFilter>
      </div>
      {url === catalogueUrl ? (
        <MetricsSnapshot
          data={catalogue.data}
          error={catalogue.error}
          scopeLabel={scopeLabel}
          onSelectScope={selectScope}
        >
          {children}
        </MetricsSnapshot>
      ) : (
        <FilteredMetrics
          key={url}
          url={url}
          scopeLabel={scopeLabel}
          onSelectScope={selectScope}
        >
          {children}
        </FilteredMetrics>
      )}
    </section>
  );
}

/** Renders a labeled native selector with visible keyboard focus and long-name truncation. */
function MetricFilter({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium sm:max-w-96">
      {label}
      <span className="relative">
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-(--console-control-height) w-full min-w-52 max-w-full appearance-none truncate rounded-md border bg-card py-1 pr-7 pl-2.5 text-[0.8125rem] font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
      </span>
    </label>
  );
}

/** Owns a fresh polling state per filter combination so old scope totals are never relabeled. */
function FilteredMetrics({
  url,
  scopeLabel,
  onSelectScope,
  children,
}: {
  url: string;
  scopeLabel: string;
  onSelectScope: (repositoryId: string, targetKey?: string) => void;
  children?: ReactNode;
}) {
  const snapshot = usePoll<ReviewMetrics>(url, undefined, 15_000);
  return (
    <MetricsSnapshot
      {...snapshot}
      scopeLabel={scopeLabel}
      onSelectScope={onSelectScope}
    >
      {children}
    </MetricsSnapshot>
  );
}

/** Presents one successful snapshot while preserving it during transient refresh failures. */
function MetricsSnapshot({
  data,
  error,
  scopeLabel,
  onSelectScope,
  summaryOnly = false,
  children,
}: {
  data?: ReviewMetrics;
  error: boolean;
  scopeLabel: string;
  onSelectScope: (repositoryId: string, targetKey?: string) => void;
  summaryOnly?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {data
              ? "Unable to refresh metrics. Showing the last successful snapshot; retrying…"
              : "Metrics are unavailable. Retrying…"}
          </AlertDescription>
        </Alert>
      )}
      {!data ? (
        !error && (
          <div
            role="status"
            aria-label="Loading review metrics"
            className="flex flex-col gap-4"
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-40" />
              ))}
            </div>
            <Skeleton className={summaryOnly ? "h-20" : "h-52"} />
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 break-words font-medium text-foreground">
              {scopeLabel}
            </span>
            <span className="flex items-center gap-2">
              {summaryOnly && (
                <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span>
                Updated{" "}
                {new Date(data.asOf).toLocaleTimeString("en-US", {
                  timeZone: "UTC",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}{" "}
                UTC · refreshes every 15 seconds
              </span>
            </span>
          </div>
          <MetricCards totals={data.totals} summaryOnly={summaryOnly} />
          {!summaryOnly && (
            <>
              {(data.totals.diffMeasuredReviews <
                data.totals.completedReviews ||
                data.totals.completeUsageAttempts < data.totals.attempts ||
                data.totals.cachedUsageRecordedAttempts <
                  data.totals.attempts) && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Some telemetry is unavailable. Diff measured for{" "}
                  {count(data.totals.diffMeasuredReviews)} /{" "}
                  {count(data.totals.completedReviews)} completed reviews;
                  complete token usage for{" "}
                  {count(data.totals.completeUsageAttempts)} /{" "}
                  {count(data.totals.attempts)} attempts; cached input usage for{" "}
                  {count(data.totals.cachedUsageRecordedAttempts)} /{" "}
                  {count(data.totals.attempts)} attempts. Missing measurements
                  are excluded from totals. See measurement and coverage below.
                </p>
              )}
            </>
          )}
          {children}
          <ActivityHeatmap
            activity={data.activity}
            asOf={data.asOf}
            from={data.range.from}
          />
          {!summaryOnly && (
            <>
              {data.totals.completedReviews === 0 && (
                <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                  No completed reviews in this scope yet. Completed reviews will
                  appear in the activity calendar and totals.
                </p>
              )}
              <MetricsBreakdown metrics={data} onSelectScope={onSelectScope} />
              <details className="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground">
                  Measurement and coverage
                </summary>
                <div className="mt-3 space-y-2 leading-relaxed">
                  <p>
                    Cumulative diff counts added and deleted lines on every
                    completed review, including repeat reviews. Distinct diff
                    counts each repository and exact base / head revision pair
                    once; it is not a count of unique source lines.
                  </p>
                  <p>
                    Confirmed resolved findings were explicitly marked resolved.
                    No longer reported findings disappeared in a later completed
                    review of the same target; this is an inference, not
                    confirmation of a fix. Findings and their current outcomes
                    are grouped by when they were first reported in the selected
                    period.
                  </p>
                  <p>
                    Tokens include recorded attempts, including failed attempts
                    and conversation replies. Input + output is the total;
                    cached input is a subset of input and is not added again.
                    Token dates follow attempt creation; review and diff dates
                    follow completion. The calendar uses UTC.
                  </p>
                  <p>
                    Historical records may lack telemetry. Missing measurements
                    are excluded, not treated as measured zero. Diff recorded:{" "}
                    {count(data.totals.diffMeasuredReviews)} /{" "}
                    {count(data.totals.completedReviews)} completed reviews.
                    Token usage recorded:{" "}
                    {count(data.totals.usageRecordedAttempts)} /{" "}
                    {count(data.totals.attempts)} attempts (
                    {count(data.totals.completeUsageAttempts)} complete; cache
                    usage recorded for{" "}
                    {count(data.totals.cachedUsageRecordedAttempts)}).
                  </p>
                </div>
              </details>
            </>
          )}
        </>
      )}
      {!data && children}
    </div>
  );
}

/** Displays an exact count and keeps all supporting measurements aligned to the bottom of its card. */
function MetricCard({
  label,
  value,
  icon: Icon,
  children,
  overview = false,
  tone,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  children: ReactNode;
  overview?: boolean;
  tone: "success" | "info" | "findings" | "tokens";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-lg border bg-card p-4",
        overview && "min-h-32",
      )}
    >
      <div
        className={cn(
          overview ? "flex items-start gap-3" : "flex flex-col gap-3",
        )}
      >
        {overview && (
          <span
            className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
            data-tone={tone}
          >
            <Icon aria-hidden="true" className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{label}</span>
            {!overview && <Icon aria-hidden="true" className="size-4" />}
          </div>
          <p
            className={cn(
              "font-semibold tracking-tight tabular-nums",
              overview ? "mt-1 break-all text-2xl" : "mt-3 truncate text-2xl",
            )}
            title={count(value)}
          >
            {count(value)}
          </p>
        </div>
      </div>
      <div
        className={cn(
          "mt-3 flex flex-1 flex-col justify-end text-xs leading-relaxed text-muted-foreground",
          overview ? "gap-0.5" : "gap-1",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Shows the requested review, diff, outcome, and token KPIs alongside operational rates. */
function MetricCards({
  totals,
  summaryOnly = false,
}: {
  totals: ReviewMetricTotals;
  summaryOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Completed reviews"
          value={totals.completedReviews}
          icon={summaryOnly ? CheckCircle2 : Activity}
          overview={summaryOnly}
          tone="success"
        >
          {summaryOnly ? (
            <span>
              {count(totals.runningReviews)} running ·{" "}
              {count(totals.queuedReviews)} queued ·{" "}
              {count(totals.failedReviews)} failed ·{" "}
              {count(totals.conversationReplies)} replies
            </span>
          ) : (
            <>
              <span>
                {count(totals.runningReviews)} running ·{" "}
                {count(totals.queuedReviews)} queued
              </span>
              <span>
                {count(totals.failedReviews)} failed ·{" "}
                {count(totals.conversationReplies)} replies
              </span>
            </>
          )}
        </MetricCard>
        <MetricCard
          label="Cumulative diff · lines"
          value={totals.addedLines + totals.deletedLines}
          icon={summaryOnly ? CodeXml : GitCompareArrows}
          overview={summaryOnly}
          tone="info"
        >
          <span>
            <span className="text-success">+{count(totals.addedLines)}</span> /{" "}
            <span className="text-destructive">
              −{count(totals.deletedLines)}
            </span>{" "}
            across review runs
          </span>
          <span>
            Distinct revisions:{" "}
            <strong className="font-medium text-foreground">
              {count(totals.distinctAddedLines + totals.distinctDeletedLines)}
            </strong>{" "}
            lines
          </span>
          <span>
            +{count(totals.distinctAddedLines)} / −
            {count(totals.distinctDeletedLines)} · {count(totals.distinctDiffs)}{" "}
            revision pairs
          </span>
        </MetricCard>
        <MetricCard
          label="Findings reported"
          value={totals.findings}
          icon={summaryOnly ? Shield : SearchCheck}
          overview={summaryOnly}
          tone="findings"
        >
          <span>
            <strong className="font-medium text-success">
              {count(totals.confirmedResolvedFindings)}
            </strong>{" "}
            confirmed resolved
          </span>
          <span>
            <strong className="font-medium text-foreground">
              {count(totals.noLongerReportedFindings)}
            </strong>{" "}
            no longer reported · inferred
          </span>
        </MetricCard>
        <MetricCard
          label="Observed tokens · input + output"
          value={totals.inputTokens + totals.outputTokens}
          icon={summaryOnly ? Database : Coins}
          overview={summaryOnly}
          tone="tokens"
        >
          <span>
            Input{" "}
            <strong className="font-medium text-foreground">
              {count(totals.inputTokens)}
            </strong>{" "}
            · output{" "}
            <strong className="font-medium text-foreground">
              {count(totals.outputTokens)}
            </strong>
          </span>
          <span>
            Cached input{" "}
            <strong className="font-medium text-foreground">
              {count(totals.cachedInputTokens)}
            </strong>
          </span>
          <span>
            {count(totals.completeUsageAttempts)} / {count(totals.attempts)}{" "}
            attempts with complete usage
          </span>
        </MetricCard>
      </div>
      <dl
        className={cn(
          "grid gap-x-6 gap-y-4 rounded-lg border bg-card",
          summaryOnly
            ? "px-5 py-5 sm:grid-cols-2 xl:grid-cols-4"
            : "px-4 py-3 sm:grid-cols-3",
        )}
      >
        <div className={cn(summaryOnly && "relative pl-10")}>
          <dt className="text-xs text-muted-foreground">
            {summaryOnly && (
              <Clock3
                aria-hidden="true"
                className="absolute top-1/2 left-0 size-6 -translate-y-1/2"
              />
            )}
            Average review duration
          </dt>
          <dd className="mt-1 font-medium tabular-nums">
            {duration(totals.averageDurationMs)}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              · {count(totals.durationMeasuredReviews)} measured
            </span>
          </dd>
        </div>
        <div
          className={cn(summaryOnly && "relative pl-10 xl:border-l xl:pl-16")}
        >
          <dt className="text-xs text-muted-foreground">
            {summaryOnly && (
              <Gauge
                aria-hidden="true"
                className="absolute top-1/2 left-0 size-6 -translate-y-1/2 xl:left-6"
              />
            )}
            Review failure rate
          </dt>
          <dd className="mt-1 font-medium tabular-nums">
            {rate(
              totals.failedReviews,
              totals.completedReviews + totals.failedReviews,
            )}
          </dd>
        </div>
        <div
          className={cn(summaryOnly && "relative pl-10 xl:border-l xl:pl-16")}
        >
          <dt className="text-xs text-muted-foreground">
            {summaryOnly && (
              <ChartNoAxesColumn
                aria-hidden="true"
                className="absolute top-1/2 left-0 size-6 -translate-y-1/2 xl:left-6"
              />
            )}
            Confirmed resolution rate
          </dt>
          <dd className="mt-1 font-medium tabular-nums">
            {rate(totals.confirmedResolvedFindings, totals.findings)}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              of reported findings
            </span>
          </dd>
        </div>
        {summaryOnly && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            <dt className="sr-only">Telemetry availability</dt>
            <dd className="flex items-center gap-3">
              <Info aria-hidden="true" className="size-5 shrink-0" />
              <span>
                Totals include recorded measurements only. Unavailable telemetry
                is excluded.
              </span>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Builds a Sunday-aligned UTC calendar and supports arrow-key navigation with a single tab stop. */
function ActivityHeatmap({
  activity,
  asOf,
  from,
}: {
  activity: ReviewActivityDay[];
  asOf: string;
  from: string | null;
}) {
  const today = new Date(`${asOf.slice(0, 10)}T00:00:00Z`);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 364);
  const firstWeekday = start.getUTCDay();
  const dailyCounts = new Map(
    activity.map((day) => [day.date, day.completedReviews]),
  );
  const days: HeatmapDay[] = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const dateKey = date.toISOString().slice(0, 10);
    return {
      date: dateKey,
      completedReviews: dailyCounts.get(dateKey) ?? 0,
      outsidePeriod: from !== null && dateKey < from.slice(0, 10),
    };
  });
  const [focusedDay, setFocusedDay] = useState(364);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const maximum = Math.max(1, ...days.map((day) => day.completedReviews));
  const weeks = Math.ceil((firstWeekday + days.length) / 7);
  const gridColumns = `repeat(${weeks}, 12px)`;
  const selected = days[focusedDay];
  const reviewedDays = days.filter((day) => day.completedReviews > 0).length;
  const reviewCount = days.reduce(
    (total, day) => total + day.completedReviews,
    0,
  );

  /** Moves focus across dates without requiring a tab stop for every day in the year. */
  function moveDay(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowUp") next -= 1;
    else if (event.key === "ArrowDown") next += 1;
    else if (event.key === "ArrowLeft") next -= 7;
    else if (event.key === "ArrowRight") next += 7;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = days.length - 1;
    else return;
    event.preventDefault();
    next = Math.max(0, Math.min(days.length - 1, next));
    setFocusedDay(next);
    buttons.current[next]?.focus();
  }

  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">Review activity</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {count(reviewCount)} completed reviews · {count(reviewedDays)}{" "}
            active days in the calendar
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          Last 365 days · UTC{from && " · selected period highlighted"}
        </span>
      </div>
      <div
        className="overflow-x-auto pb-2"
        role="group"
        aria-label="Daily completed reviews; use arrow keys to explore dates"
      >
        <div className="mx-auto w-max">
          <div
            className="mb-2 ml-8 grid h-4 gap-[3px] text-[10px] text-muted-foreground"
            style={{ gridTemplateColumns: gridColumns }}
            aria-hidden="true"
          >
            {days
              .filter((day) => day.date.endsWith("-01"))
              .map((day) => (
                <span
                  key={day.date}
                  style={{
                    gridColumn:
                      Math.floor((firstWeekday + days.indexOf(day)) / 7) + 1,
                  }}
                >
                  {monthFormatter.format(new Date(`${day.date}T00:00:00Z`))}
                </span>
              ))}
          </div>
          <div className="flex gap-3">
            <div
              className="grid w-5 grid-rows-7 gap-[3px] text-[10px] leading-3 text-muted-foreground"
              aria-hidden="true"
            >
              {["", "Mon", "", "Wed", "", "Fri", ""].map((label, index) => (
                <span key={index}>{label}</span>
              ))}
            </div>
            <div
              className="grid grid-flow-col grid-rows-7 gap-[3px]"
              style={{ gridTemplateColumns: gridColumns }}
            >
              {Array.from({ length: firstWeekday }, (_, index) => (
                <span
                  key={`padding-${index}`}
                  className="size-3"
                  aria-hidden="true"
                />
              ))}
              {days.map((day, index) => {
                const level = day.completedReviews
                  ? Math.max(1, Math.ceil((day.completedReviews / maximum) * 4))
                  : 0;
                const label = `${dayFormatter.format(new Date(`${day.date}T00:00:00Z`))}: ${count(day.completedReviews)} completed reviews${day.outsidePeriod ? "; outside selected period" : ""}`;
                return (
                  <button
                    type="button"
                    key={day.date}
                    ref={(element) => {
                      buttons.current[index] = element;
                    }}
                    tabIndex={focusedDay === index ? 0 : -1}
                    aria-label={label}
                    title={label}
                    onFocus={() => setFocusedDay(index)}
                    onClick={() => setFocusedDay(index)}
                    onKeyDown={(event) => moveDay(event, index)}
                    className={`size-3 rounded-[2px] ring-1 ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card ${heatColors[level]} ${day.outsidePeriod ? "opacity-30" : ""}`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {dayFormatter.format(new Date(`${selected.date}T00:00:00Z`))} ·{" "}
          {selected.outsidePeriod
            ? "outside selected period"
            : `${count(selected.completedReviews)} completed reviews`}
        </span>
        <div
          className="flex items-center gap-1.5"
          aria-label="Color intensity increases with daily completed review count"
        >
          <span className="mr-1">Less</span>
          {heatColors.map((color, index) => (
            <span
              key={color}
              className={`size-3 rounded-[2px] ring-1 ring-inset ${color}`}
              title={
                index === 0
                  ? "No completed reviews"
                  : `Activity intensity ${index} of 4`
              }
              aria-hidden="true"
            />
          ))}
          <span className="ml-1">More</span>
        </div>
      </div>
    </div>
  );
}

/** Lists repository and overlapping target rollups separately, with every requested KPI in each row. */
function MetricsBreakdown({
  metrics,
  onSelectScope,
}: {
  metrics: ReviewMetrics;
  onSelectScope: (repositoryId: string, targetKey?: string) => void;
}) {
  const [breakdown, setBreakdown] = useState<Breakdown>("repositories");
  const options: { value: Breakdown; label: string }[] = [
    { value: "repositories", label: "Repositories" },
    { value: "changes", label: "Pull / merge requests" },
    { value: "branches", label: "Source branches" },
    { value: "revisions", label: "Other revisions" },
  ];
  const kind =
    breakdown === "changes"
      ? "change"
      : breakdown === "branches"
        ? "branch"
        : "revision";
  const rows: (RepositoryReviewMetrics | TargetReviewMetrics)[] =
    breakdown === "repositories"
      ? metrics.repositories
      : metrics.targets.filter((row) => row.target.kind === kind);
  return (
    <div className="min-w-0 rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h3 id="metrics-breakdown" className="font-medium">
          Metrics by scope
        </h3>
        <div className="flex flex-wrap gap-1" aria-label="Metrics grouping">
          {options.map((option) => (
            <Button
              key={option.value}
              variant={breakdown === option.value ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={breakdown === option.value}
              onClick={() => setBreakdown(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {rows.length ? (
        <Table
          className="min-w-[1450px] text-xs"
          aria-labelledby="metrics-breakdown"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-52 bg-card pl-4">
                {breakdown === "repositories" ? "Repository" : "Target"}
              </TableHead>
              <TableHead className="text-right">Reviews</TableHead>
              <TableHead className="text-right">
                Cumulative diff + / −
              </TableHead>
              <TableHead className="text-right">Distinct diff + / −</TableHead>
              <TableHead className="text-right">Findings</TableHead>
              <TableHead className="text-right">Confirmed resolved</TableHead>
              <TableHead className="text-right">No longer reported</TableHead>
              <TableHead className="text-right">Input tokens</TableHead>
              <TableHead className="text-right">Output tokens</TableHead>
              <TableHead className="text-right">Cached input</TableHead>
              <TableHead className="text-right">Avg. duration</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="pr-4 text-right">
                Telemetry coverage
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <MetricRow
                key={`${row.repositoryId}:${"target" in row ? row.target.key : "repository"}`}
                row={row}
                onSelectScope={onSelectScope}
              />
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No{" "}
          {options
            .find((option) => option.value === breakdown)
            ?.label.toLowerCase()}{" "}
          to show for this scope and period.
        </p>
      )}
      <p className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        Reviews are completed runs. Branch and pull / merge request groups can
        contain the same reviews; compare them separately. Cached tokens are
        included in input. Scroll horizontally to see all metrics.
      </p>
    </div>
  );
}

/** Renders exact rollup counts and provides a drill-down for a repository, branch, or change. */
function MetricRow({
  row,
  onSelectScope,
}: {
  row: RepositoryReviewMetrics | TargetReviewMetrics;
  onSelectScope: (repositoryId: string, targetKey?: string) => void;
}) {
  const totals = row.totals;
  const target = "target" in row ? row.target : undefined;
  const label = target?.label ?? row.repositoryName;
  return (
    <TableRow>
      <TableCell className="sticky left-0 z-10 max-w-72 bg-card pl-4">
        {target?.kind === "revision" ? (
          <span className="block truncate font-medium" title={label}>
            {label}
          </span>
        ) : (
          <button
            type="button"
            className="block max-w-full truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            title={label}
            onClick={() => onSelectScope(row.repositoryId, target?.key)}
          >
            {label}
          </button>
        )}
        {target && (
          <span
            className="mt-1 block truncate text-muted-foreground"
            title={row.repositoryName}
          >
            {row.repositoryName}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.completedReviews)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="text-success">+{count(totals.addedLines)}</span> /{" "}
        <span className="text-destructive">−{count(totals.deletedLines)}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        +{count(totals.distinctAddedLines)} / −
        {count(totals.distinctDeletedLines)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.findings)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.confirmedResolvedFindings)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.noLongerReportedFindings)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.inputTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.outputTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.cachedInputTokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {duration(totals.averageDurationMs)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {count(totals.failedReviews)}
      </TableCell>
      <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
        <span className="block">
          Diff {count(totals.diffMeasuredReviews)} /{" "}
          {count(totals.completedReviews)} reviews
        </span>
        <span className="mt-1 block">
          Usage {count(totals.usageRecordedAttempts)} / {count(totals.attempts)}{" "}
          attempts
        </span>
      </TableCell>
    </TableRow>
  );
}
