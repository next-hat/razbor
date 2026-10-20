import { Writable, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "node:net";

import type Docker from "dockerode";

import {
  reviewProgressSchema,
  reviewAttemptMetricsSchema,
  type ReviewAttemptMetrics,
  type ReviewProgress,
} from "@razbor/contracts";

/**
 * Parse a framed progress payload and forward only schema-valid events; ignore malformed
 * lines and return false so the stream owner can invalidate usage coverage.
 */
function reportLine(line: string, report: (event: ReviewProgress) => void) {
  try {
    const event = reviewProgressSchema.safeParse(
      JSON.parse(line.slice("RAZBOR_PROGRESS ".length)),
    );
    if (event.success) {
      report({ ...event.data, source: "agent" });
      return true;
    }
  } catch {
    /* Ignore malformed or unrelated diagnostic lines. */
  }
  return false;
}

// Only explicit harness progress is forwarded, including selected, sanitized tool
// summaries. Model bodies, raw arguments, credentials and arbitrary output stay private.
/**
 * Follow container stdout for bounded, explicitly framed progress events while discarding
 * stderr and arbitrary output. Return a completion promise and explicit stream cleanup.
 * Interrupted, malformed or truncated progress makes token coverage incomplete.
 */
export async function followProgress(
  docker: Docker,
  container: Docker.Container,
  signal: AbortSignal,
  report: (event: ReviewProgress) => void,
) {
  const stream = (await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    abortSignal: signal,
  })) as Readable & { socket?: Socket };
  // The normal Docker request timeout must not cut off quiet model turns.
  // The attempt's AbortSignal still bounds the lifetime of this stream.
  stream.socket?.setTimeout(0);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  let ended = false;
  let incomplete = false;
  /** Emit one safe warning that invalidates usage coverage after a progress gap. */
  const markIncomplete = (message: string) => {
    if (incomplete || signal.aborted) return;
    incomplete = true;
    report({
      time: new Date().toISOString(),
      source: "runner",
      level: "warn",
      stage: "agent",
      message,
      tokenUsageComplete: false,
    });
  };
  const output = new Writable({
    /**
     * Decode stdout incrementally, discard oversized lines, and forward only complete
     * RAZBOR_PROGRESS records.
     */
    write(chunk, _encoding, done) {
      const text = decoder.write(chunk);
      for (const part of text.split(/(?<=\n)/)) {
        if (!dropping) pending += part;
        if (pending.length > 8192) {
          if (pending.startsWith("RAZBOR_PROGRESS "))
            markIncomplete(
              "Agent progress exceeded its limit; token usage may be incomplete",
            );
          pending = "";
          dropping = true;
        }
        if (!part.endsWith("\n")) continue;
        if (!dropping && pending.startsWith("RAZBOR_PROGRESS ")) {
          if (!reportLine(pending, report))
            markIncomplete(
              "Agent progress was invalid; token usage may be incomplete",
            );
        }
        pending = "";
        dropping = false;
      }
      done();
    },
  });
  const discard = new Writable({
    /** Consume discarded stderr without exposing diagnostic content as public progress. */
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const done = new Promise<void>((resolve) => {
    stream.once("end", () => {
      ended = true;
      if (pending.startsWith("RAZBOR_PROGRESS "))
        markIncomplete(
          "Agent progress ended mid-record; token usage may be incomplete",
        );
      resolve();
    });
    stream.once("close", () => {
      if (!ended)
        markIncomplete(
          "Agent log stream closed early; token usage may be incomplete",
        );
      resolve();
    });
    stream.once("error", () => {
      markIncomplete(
        "Agent log stream interrupted; subsequent progress may be unavailable",
      );
      resolve();
    });
  });
  docker.modem.demuxStream(stream, output, discard);
  return {
    done,
    /** Destroy the Docker log stream and both demultiplexed sinks when the attempt ends. */
    close: () => {
      stream.destroy();
      output.destroy();
      discard.destroy();
    },
  };
}

/** Retain cumulative attempt metrics and bound full progress events before transport. */
export class AttemptProgress {
  metrics: ReviewAttemptMetrics | undefined;
  private count = 0;
  private lastMetrics = "{}";
  private context: Pick<
    ReviewProgress,
    "source" | "model" | "turn" | "maxTurns"
  > = {};

  /** Return a full event or changed metric snapshot, omitting repeated post-limit events. */
  capture(event: ReviewProgress): ReviewProgress | undefined {
    const metrics = reviewAttemptMetricsSchema.strip().parse(event);
    // Omitted metrics must not erase values retained from earlier snapshots.
    for (const key of Object.keys(metrics) as (keyof ReviewAttemptMetrics)[])
      if (metrics[key] === undefined) delete metrics[key];
    if (Object.keys(metrics).length) {
      const incomplete = this.metrics?.tokenUsageComplete === false;
      const costIncomplete = this.metrics?.costEstimateComplete === false;
      this.metrics = { ...this.metrics, ...metrics };
      if (
        incomplete ||
        metrics.tokenUsageComplete === false ||
        (metrics.inputTokens !== undefined &&
          metrics.cachedInputTokens === undefined)
      )
        delete this.metrics.cachedInputTokens;
      for (const key of ["uncachedInputTokens", "cacheWriteTokens"] as const)
        if (
          incomplete ||
          metrics.tokenUsageComplete === false ||
          (metrics.inputTokens !== undefined && metrics[key] === undefined)
        )
          delete this.metrics[key];
      if (
        costIncomplete ||
        metrics.costEstimateComplete === false ||
        ((incomplete || metrics.tokenUsageComplete === false) &&
          this.metrics.estimatedCostUsd !== undefined)
      )
        this.metrics.costEstimateComplete = false;
      if (incomplete) this.metrics.tokenUsageComplete = false;
    }
    for (const key of ["source", "model", "turn", "maxTurns"] as const)
      if (event[key] !== undefined)
        Object.assign(this.context, { [key]: event[key] });
    if (metrics.modelTurns !== undefined)
      this.context.turn = metrics.modelTurns;
    const cumulative = { ...this.context, ...this.metrics };
    const snapshot = JSON.stringify(cumulative);
    let payload: ReviewProgress = {
      ...event,
      ...cumulative,
      // A usage gap invalidates these categories even if a later event reports them.
      cachedInputTokens: this.metrics?.cachedInputTokens,
      uncachedInputTokens: this.metrics?.uncachedInputTokens,
      cacheWriteTokens: this.metrics?.cacheWriteTokens,
    };
    if (this.count++ >= 500) {
      if (snapshot === "{}" || snapshot === this.lastMetrics) return undefined;
      payload = {
        time: event.time,
        level: event.level,
        stage: event.stage,
        message: "Review metrics updated",
        ...cumulative,
      };
    }
    if (snapshot !== "{}") this.lastMetrics = snapshot;
    return payload;
  }
}
