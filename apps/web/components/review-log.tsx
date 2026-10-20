"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Pause } from "lucide-react";

import type { ReviewJobView } from "@razbor/contracts";

import type { LogLine } from "@web/lib/use-review-stream.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { cn } from "@web/lib/utils.js";

const connectionLabels: Record<string, string> = {
  live: "Live updates",
  finished: "Execution finished",
  reconnecting: "Connection lost · reconnecting…",
};

const sourceLabels = {
  app: "App",
  runner: "Runner",
  agent: "Agent",
};

const toolStatusLabels = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  unavailable: "Outcome unavailable",
};

/**
 * Coalesce each attempt's tool updates into its first row, keeping the original
 * sequence and start time even when concurrent tools finish in a different order.
 */
function activityRows(lines: LogLine[]) {
  const rows: LogLine[] = [];
  const tools = new Map<string, number>();
  for (const line of lines) {
    if (!line.tool) {
      rows.push(line);
      continue;
    }
    const key = `${line.attemptId}:${line.tool.id}`;
    const index = tools.get(key);
    if (index === undefined) {
      tools.set(key, rows.length);
      rows.push(line);
      continue;
    }
    const original = rows[index];
    rows[index] = {
      ...original,
      ...line,
      sequence: original.sequence,
      time: original.time,
      tool: { ...original.tool, ...line.tool },
    };
  }
  return rows;
}

/** Identify routine detail events; warnings, errors and failed tools remain visible. */
function isDetail(line: LogLine) {
  return (
    line.detail === true &&
    line.level === "info" &&
    line.tool?.status !== "failed"
  );
}

/** Describe the recorded tool outcome without exposing its output or raw arguments. */
function toolOutcome(tool: NonNullable<LogLine["tool"]>) {
  const parts: string[] = [];
  if (tool.durationMs !== undefined)
    parts.push(
      tool.durationMs < 1000
        ? `${Math.round(tool.durationMs)}ms`
        : `${(tool.durationMs / 1000).toFixed(1)}s`,
    );
  if (tool.exitCode !== undefined)
    parts.push(`exit ${tool.exitCode ?? "unknown"}`);
  if (tool.timedOut) parts.push("timed out");
  if (tool.cancelled) parts.push("cancelled");
  return parts.join(" · ");
}

/**
 * Returns nonnegative elapsed execution seconds, or no value until both timing
 * endpoints are known.
 */
function elapsedSeconds(job: ReviewJobView, now: number | undefined) {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  if (!job.startedAt || end === undefined) return undefined;
  return Math.max(0, Math.floor((end - Date.parse(job.startedAt)) / 1000));
}

/**
 * Displays stacked events with timestamp and source/tool tags above their messages,
 * derives latest-attempt usage, and follows changes until scrolling is paused.
 */
export function ReviewLog({
  lines,
  job,
  connection,
  available,
}: Readonly<{
  lines: LogLine[];
  job: ReviewJobView;
  connection: string;
  available: boolean;
}>) {
  const viewport = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState<number>();
  const rows = useMemo(() => activityRows(lines), [lines]);
  const visibleRows = showDetails
    ? rows
    : rows.filter((line) => !isDetail(line));
  const hiddenCount = rows.length - visibleRows.length;
  const active = job.status === "running" || job.status === "queued";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (follow && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lines, follow, showDetails]);
  const latest = lines.at(-1);
  const attempt = [...lines]
    .reverse()
    .filter((line) => line.attemptId === latest?.attemptId);
  const model = attempt.find((line) => line.model)?.model;
  const maxTurns = attempt.find(
    (line) => line.maxTurns !== undefined,
  )?.maxTurns;
  // Transport may retain cumulative metric events without the older turn field.
  // Select costs and token categories from the same latest snapshot.
  const stats =
    attempt.find((line) =>
      [
        line.modelTurns,
        line.inputTokens,
        line.outputTokens,
        line.toolCalls,
        line.estimatedCostUsd,
        line.tokenUsageComplete,
      ].some((value) => value !== undefined),
    ) ?? attempt.find((line) => line.turn !== undefined);
  const turn =
    stats?.modelTurns ??
    stats?.turn ??
    attempt.find((line) => line.turn !== undefined)?.turn;
  const cost = stats;
  const elapsed = elapsedSeconds(job, now);
  return (
    <section
      aria-labelledby="execution-heading"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-col gap-1">
          <h2 id="execution-heading" className="text-sm font-semibold">
            Execution log
          </h2>
          <output className="block text-xs text-muted-foreground">
            {connectionLabels[connection] ?? "Connecting…"}
            {elapsed !== undefined &&
              ` · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
          </output>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={showDetails}
            aria-controls="execution-log"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? "Hide details" : "Show details"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            {follow ? (
              <Pause data-icon="inline-start" />
            ) : (
              <ArrowDown data-icon="inline-start" />
            )}
            {follow ? "Pause scrolling" : "Follow log"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-b bg-muted/40 px-4 py-3 text-xs tabular-nums">
        <span className="min-w-0 break-all">
          <span className="text-muted-foreground">Model</span>{" "}
          <strong>
            {model ?? (job.status === "queued" ? "Pending" : "Not recorded")}
          </strong>
        </span>
        <span>
          <strong>{turn ?? 0}</strong>
          {maxTurns !== undefined && ` / ${maxTurns}`} turns{" "}
          <span className="text-muted-foreground">this attempt</span>
        </span>
        <span>
          <strong>{stats?.toolCalls ?? 0}</strong> tool calls
        </span>
        <span>
          <strong>{stats?.inputTokens ?? "—"}</strong> reported input tokens
        </span>
        <span>
          <strong>{stats?.outputTokens ?? "—"}</strong> reported output tokens
        </span>
        {stats?.uncachedInputTokens !== undefined && (
          <span>
            <strong>{stats.uncachedInputTokens}</strong> uncached input tokens
          </span>
        )}
        {stats?.cachedInputTokens !== undefined && (
          <span>
            <strong>{stats.cachedInputTokens}</strong> cached input tokens
          </span>
        )}
        {stats?.cacheWriteTokens !== undefined &&
          stats.cacheWriteTokens > 0 && (
            <span>
              <strong>{stats.cacheWriteTokens}</strong> cache-write tokens
            </span>
          )}
        {cost?.estimatedCostUsd !== undefined && (
          <span
            title={
              cost.costEstimateComplete !== true
                ? "Usage is incomplete; this estimate may differ from provider charges."
                : "Estimated from recorded token categories and configured model prices."
            }
          >
            <strong>{cost.estimatedCostUsd.toFixed(6)} USD</strong>{" "}
            {cost.costEstimateComplete !== true
              ? "estimated cost · incomplete usage"
              : "estimated cost"}
          </span>
        )}
      </div>
      {!available && (
        <output className="block border-b px-4 py-3 text-sm text-destructive">
          Log storage unavailable. Retrying; existing lines remain visible.
        </output>
      )}
      <div
        id="execution-log"
        ref={viewport}
        role="log"
        aria-label="Review execution"
        aria-live="off"
        tabIndex={0}
        onScroll={() => {
          const el = viewport.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 48)
            setFollow(false);
        }}
        className="h-48 overflow-auto p-4 text-xs leading-5"
      >
        {visibleRows.length ? (
          visibleRows.map((line, index) => {
            // A missing completion in retained logs does not prove a tool is still running.
            const status =
              line.tool?.status === "running" &&
              (job.status !== "running" || line.attemptId !== latest?.attemptId)
                ? "unavailable"
                : line.tool?.status;
            return (
              <div key={line.sequence}>
                {line.attemptId !== visibleRows[index - 1]?.attemptId && (
                  <p className="mt-3 mb-2 break-all font-semibold first:mt-0">
                    Attempt {line.attemptId}
                  </p>
                )}
                <div
                  className={cn(
                    "flex min-w-0 flex-col gap-1 rounded-sm py-1 hover:bg-muted/50",
                    (line.level === "error" ||
                      line.tool?.status === "failed") &&
                      "text-destructive",
                  )}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
                    <time
                      dateTime={line.time}
                      className="font-mono tabular-nums"
                    >
                      {line.time.slice(11, 19)}
                    </time>
                    {line.source && (
                      <Badge variant="outline">
                        {sourceLabels[line.source]}
                      </Badge>
                    )}
                    {line.tool && (
                      <>
                        <Badge variant="outline" className="max-w-full">
                          <span className="truncate" title={line.tool.name}>
                            {line.tool.name}
                          </span>
                        </Badge>
                        <Badge
                          variant={
                            status === "unavailable"
                              ? "warning"
                              : status === "failed"
                                ? "destructive"
                                : status === "running"
                                  ? "info"
                                  : "secondary"
                          }
                        >
                          {toolStatusLabels[status ?? line.tool.status]}
                        </Badge>
                        <span className="tabular-nums">
                          {toolOutcome(line.tool)}
                        </span>
                      </>
                    )}
                  </div>
                  <p className="min-w-0 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {!line.tool &&
                      line.level !== "info" &&
                      `${line.level.toUpperCase()} · `}
                    {line.tool?.summary ?? line.message}
                  </p>
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-muted-foreground">
            {rows.length
              ? "No summary activity yet. Show details to inspect retained events."
              : active
                ? "Waiting for the runner to report progress…"
                : "No execution logs retained for this review. Logs are available for new attempts until queue retention removes them."}
          </p>
        )}
      </div>
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">
        <p className="break-words">
          {visibleRows.length} activities
          {hiddenCount > 0 && ` · ${hiddenCount} details hidden`} · timestamps
          in UTC
        </p>
      </div>
    </section>
  );
}
