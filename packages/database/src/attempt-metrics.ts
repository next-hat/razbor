import { eq } from "drizzle-orm";

import {
  publicIdSchema,
  reviewAttemptMetricsSchema,
  type ReviewAttemptMetrics,
  type ReviewProgress,
} from "@razbor/contracts";

import type { Database } from "@database/src/connection.js";
import {
  repositories,
  reviewAttempts,
  reviews,
  runners,
} from "@database/src/schema.js";

const cumulativeKeys = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "uncachedInputTokens",
  "cacheWriteTokens",
  "modelTurns",
  "toolCalls",
  "budgetTokens",
  "estimatedCostUsd",
] as const;

const comparisonKeys = ["addedLines", "deletedLines", "changedFiles"] as const;

/**
 * Merge cumulative snapshots without double-counting replayed events or allowing
 * older snapshots to reduce totals. Comparison statistics are immutable within an
 * attempt. Once cached usage or total usage is incomplete, later snapshots cannot
 * make the attempt appear fully measured.
 */
function mergeMetrics(
  previous: ReviewAttemptMetrics | null,
  incoming: ReviewAttemptMetrics,
): ReviewAttemptMetrics | undefined {
  for (const key of cumulativeKeys) {
    const saved = previous?.[key];
    const next = incoming[key];
    if (saved !== undefined && next !== undefined && next < saved)
      return undefined;
  }
  for (const key of comparisonKeys) {
    const saved = previous?.[key];
    const next = incoming[key];
    if (saved !== undefined && next !== undefined && saved !== next)
      return undefined;
  }
  const merged = { ...previous, ...incoming };
  if (previous?.tokenUsageComplete === false) merged.tokenUsageComplete = false;
  if (
    previous?.costEstimateComplete === false ||
    (merged.tokenUsageComplete === false &&
      merged.estimatedCostUsd !== undefined)
  )
    merged.costEstimateComplete = false;
  if (
    merged.tokenUsageComplete === false ||
    (incoming.inputTokens !== undefined &&
      incoming.cachedInputTokens === undefined) ||
    (previous?.inputTokens !== undefined &&
      previous.cachedInputTokens === undefined)
  )
    delete merged.cachedInputTokens;
  for (const key of ["uncachedInputTokens", "cacheWriteTokens"] as const)
    if (
      merged.tokenUsageComplete === false ||
      (incoming.inputTokens !== undefined && incoming[key] === undefined) ||
      (previous?.inputTokens !== undefined && previous[key] === undefined)
    )
      delete merged[key];
  if (
    merged.cachedInputTokens !== undefined &&
    (merged.inputTokens === undefined ||
      merged.cachedInputTokens > merged.inputTokens)
  )
    return undefined;
  return reviewAttemptMetricsSchema.parse(merged);
}

/**
 * Save a validated attempt snapshot before bounded progress logging. Row locks serialize
 * progress with completion, retries and session changes; expired leases, replaced
 * versions, inactive repositories and revoked runner sessions return false. Stale
 * or conflicting snapshots are acknowledged without overwriting durable totals.
 * Missing telemetry leaves historic attempts unknown rather than fabricating zeros.
 * Only trusted completion handling may set finalized; progress payloads cannot
 * promote a live snapshot to complete transport coverage.
 */
export async function recordAttemptMetrics(
  database: Database,
  reviewId: string,
  attemptId: string,
  owner: string,
  event: ReviewProgress | ReviewAttemptMetrics,
  finalized = false,
): Promise<boolean> {
  publicIdSchema("review").parse(reviewId);
  publicIdSchema("attempt").parse(attemptId);
  const incoming: ReviewAttemptMetrics = reviewAttemptMetricsSchema
    .omit({ finalized: true })
    .strip()
    .parse(event);
  // Optional properties explicitly set to undefined must not erase saved values.
  for (const key of Object.keys(incoming) as (keyof ReviewAttemptMetrics)[])
    if (incoming[key] === undefined) delete incoming[key];
  if (finalized) incoming.finalized = true;
  if (!Object.values(incoming).some((value) => value !== undefined))
    return true;
  return database.transaction(async (tx) => {
    // Match completion and renewal lock ordering so cumulative writes cannot race
    // a terminal outcome or replacement execution version.
    const [review] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.publicId, reviewId))
      .for("update");
    const [attempt] = await tx
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.publicId, attemptId))
      .for("update");
    if (
      !review ||
      !attempt ||
      attempt.reviewId !== review.id ||
      attempt.version !== review.version ||
      attempt.owner !== owner ||
      review.status !== "running" ||
      attempt.status !== "running"
    )
      return false;
    let sessionExpiresAt: Date | undefined;
    if (attempt.runnerId) {
      const [runner] = await tx
        .select()
        .from(runners)
        .where(eq(runners.id, attempt.runnerId))
        .for("share");
      if (
        !runner ||
        runner.state === "revoked" ||
        !runner.credentialHash ||
        runner.sessionId !== attempt.runnerSessionId ||
        !runner.sessionExpiresAt ||
        !attempt.deadline
      )
        return false;
      sessionExpiresAt = runner.sessionExpiresAt;
    }
    const [repository] = await tx
      .select({ status: repositories.status })
      .from(repositories)
      .where(eq(repositories.id, review.repositoryId))
      .for("share");
    if (repository?.status !== "active") return false;
    // Check time after waiting for every lock; a lease may expire while blocked.
    const now = new Date();
    if (
      attempt.leaseUntil <= now ||
      (attempt.runnerId &&
        (!sessionExpiresAt ||
          sessionExpiresAt <= now ||
          !attempt.deadline ||
          attempt.deadline <= now))
    )
      return false;
    const metrics = mergeMetrics(attempt.metrics, incoming);
    if (!metrics) return true;
    if (
      attempt.metrics &&
      Object.keys(reviewAttemptMetricsSchema.shape).every(
        (key) =>
          attempt.metrics?.[key as keyof ReviewAttemptMetrics] ===
          metrics[key as keyof ReviewAttemptMetrics],
      )
    )
      return true;
    await tx
      .update(reviewAttempts)
      .set({ metrics, updatedAt: now })
      .where(eq(reviewAttempts.id, attempt.id));
    return true;
  });
}
