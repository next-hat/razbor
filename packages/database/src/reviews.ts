import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  publicIdSchema,
  reviewRequestSchema,
  reviewResultSchema,
  reviewEvaluationSchema,
  reviewEvaluationUpdateSchema,
  validateFindingChecks,
  type ModelProvider,
  type ReasoningEffort,
  type QueueJob,
  type ReviewEvaluation,
} from "@razbor/contracts";

import { reviewView, reviewViewSelection } from "@database/src/review-view.js";
import { snapshotRepositoryAgent } from "@database/src/agents.js";
import type { Database, Transaction } from "@database/src/connection.js";
import {
  agents,
  reviews,
  reviewAttempts,
  reviewTriggers,
  repositories,
  pullRequests,
  dispatchOutbox,
  runners,
  runnerRepositories,
} from "@database/src/schema.js";
import { publicId } from "@database/src/ids.js";
import { snapshotRepositoryMcpServers } from "@database/src/mcp.js";
import { snapshotRepositoryGuidance } from "@database/src/skills.js";
import {
  requireContextSession,
  requireRepositorySession,
} from "@database/src/contexts.js";
import { AuthInputError } from "@database/src/auth.js";

/**
 * Atomically snapshot an active repository's source policy and assigned
 * profile, save a queued review with optional reporting branch labels, and create
 * its dispatch outbox entry. Branch labels never select the checked-out revisions.
 */
export async function submitReview(
  database: Database,
  input: unknown,
  sessionToken?: string,
  contextId?: string,
  pullRequestId?: string,
) {
  const inputRequest = reviewRequestSchema.parse(input);
  return database.transaction(async (tx) => {
    const access =
      sessionToken !== undefined
        ? await requireContextSession(tx, sessionToken, contextId ?? "", "read")
        : undefined;
    const [repo] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.publicId, inputRequest.repositoryId))
      .for("share");
    if (repo?.status !== "active" || (repo.forgeId && !repo.verifiedAt))
      throw new Error("registered and verified repository required");
    if (access) {
      if (repo.contextId !== access.context.id)
        throw new AuthInputError(404, "Repository not found.");
      await requireRepositorySession(tx, sessionToken, repo.id, "read");
    }
    // Match deletion's repository-before-PR lock order and authorize the owner
    // before reading or pinning any saved provider target.
    const [target] = pullRequestId
      ? await tx
          .select()
          .from(pullRequests)
          .where(
            and(
              eq(
                pullRequests.publicId,
                publicIdSchema("pullRequest").parse(pullRequestId),
              ),
              eq(pullRequests.repositoryId, repo.id),
            ),
          )
          .for("share")
      : [];
    if (pullRequestId && !target)
      throw new AuthInputError(404, "Pull request not found.");
    const request = target
      ? {
          ...inputRequest,
          baseSha: target.baseSha,
          headSha: target.headSha,
          headBranch: target.headBranch ?? undefined,
          baseBranch: target.baseBranch ?? undefined,
        }
      : inputRequest;
    const agent = await snapshotRepositoryAgent(
      tx,
      repo.agentId,
      repo.contextId,
    );
    const guidance = await snapshotRepositoryGuidance(
      tx,
      repo.guidance,
      repo.contextId,
    );
    const mcpServers = await snapshotRepositoryMcpServers(tx, repo.id);
    const [row] = await tx
      .insert(reviews)
      .values({
        publicId: publicId("review"),
        repositoryId: repo.id,
        baseSha: request.baseSha,
        headSha: request.headSha,
        source: {
          configKey: repo.configKey,
          git: repo.git,
          indexOwner: repo.indexOwner,
          ...(target
            ? {
                pullRequest: {
                  number: target.number,
                  title: target.title,
                  url: target.url,
                  baseSha: target.baseSha,
                },
              }
            : {}),
          ...(request.headBranch ? { headBranch: request.headBranch } : {}),
          ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
          ...(agent ? { agent } : {}),
          ...(guidance ? { guidance } : {}),
          ...(mcpServers.length ? { mcpServers } : {}),
        },
      })
      .returning();
    await tx.insert(dispatchOutbox).values({ reviewId: row.id });
    return {
      id: row.publicId,
      status: "queued" as const,
      statusUrl: `/reviews/${row.publicId}`,
    };
  });
}

/**
 * Return up to fifty newest reviews, optionally restricted to a repository
 * and an access-grant list. An empty grant list returns no reviews.
 */
export async function listReviews(
  database: Database,
  repositoryId?: string,
  repositoryIds?: string[],
) {
  if (repositoryId) publicIdSchema("repository").parse(repositoryId);
  repositoryIds?.forEach((id) => publicIdSchema("repository").parse(id));
  return (
    await database.db
      .select(reviewViewSelection)
      .from(reviews)
      .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
      .leftJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
      .where(
        and(
          repositoryId ? eq(repositories.publicId, repositoryId) : undefined,
          repositoryIds !== undefined
            ? inArray(repositories.publicId, repositoryIds)
            : undefined,
        ),
      )
      .orderBy(desc(reviews.createdAt))
      .limit(50)
  ).map(reviewView);
}

/** Read a review by public ID, returning undefined when it does not exist. */
export async function getReview(database: Database, id: string) {
  publicIdSchema("review").parse(id);
  const [row] = await database.db
    .select(reviewViewSelection)
    .from(reviews)
    .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
    .leftJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .where(eq(reviews.publicId, id));
  return row ? reviewView(row) : undefined;
}

export class ReviewEvaluationInputError extends Error {
  /** Identify invalid updates or reviews that cannot accept manual evaluation. */
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "ReviewEvaluationInputError";
  }
}

/**
 * Update one manual evaluation mark on a completed review under a row lock.
 * Finding indices refer only to this saved result; marks never alter findings,
 * publication, resolution, or later review runs. Return undefined for a missing
 * review, and reject invalid input or conversational/incomplete reviews.
 * Scoped console mutations recheck live management permission before locking the review.
 */
export async function updateReviewEvaluation(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<ReviewEvaluation | undefined> {
  const reviewId = publicIdSchema("review").safeParse(id);
  const update = reviewEvaluationUpdateSchema.safeParse(input);
  if (!reviewId.success || !update.success)
    throw new ReviewEvaluationInputError("Invalid review evaluation update");
  return database.transaction(async (tx) => {
    if (sessionToken !== undefined)
      await requireContextSession(
        tx,
        sessionToken,
        contextId ?? "",
        "repositories",
      );
    const [row] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.publicId, reviewId.data),
          contextId === undefined
            ? undefined
            : sql`exists (select 1 from repositories owning_repository where owning_repository.id = ${reviews.repositoryId} and owning_repository.context_id = (select id from account_contexts where public_id = ${contextId}))`,
        ),
      )
      .for("update");
    if (!row) return undefined;
    if (
      row.status !== "completed" ||
      !row.result ||
      row.source.conversation ||
      row.result.mode === "conversation"
    )
      throw new ReviewEvaluationInputError(
        "Only completed code reviews can be evaluated",
        409,
      );
    const evaluation = reviewEvaluationSchema.parse(row.evaluation);
    if ("included" in update.data) {
      evaluation.included = update.data.included;
    } else {
      const { findingIndex, verdict } = update.data;
      if (findingIndex >= row.result.findings.length)
        throw new ReviewEvaluationInputError("Finding index is out of range");
      const key = String(findingIndex);
      if (verdict === null) delete evaluation.findings[key];
      else evaluation.findings[key] = verdict;
    }
    await tx
      .update(reviews)
      .set({ evaluation, updatedAt: new Date() })
      .where(eq(reviews.id, row.id));
    return evaluation;
  });
}

/**
 * Read the oldest undispatched jobs after webhook acknowledgement; optional
 * runner eligibility is applied before the batch limit to avoid starving
 * runnable work.
 */
export async function pendingDispatches(
  database: Database,
  eligibleOnly = false,
): Promise<QueueJob[]> {
  const rows = await database.db
    .select({
      publicId: reviews.publicId,
      repositoryPublicId: repositories.publicId,
      baseSha: reviews.baseSha,
      headSha: reviews.headSha,
      createdAt: reviews.createdAt,
    })
    .from(dispatchOutbox)
    .innerJoin(reviews, eq(dispatchOutbox.reviewId, reviews.id))
    .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
    .where(
      and(
        isNull(dispatchOutbox.dispatchedAt),
        eq(repositories.status, "active"),
        eligibleOnly
          ? sql`exists (select 1 from ${runners} where ${eligibleRunner(reviews.repositoryId, sql`(${reviews.source}->'agent' is not null or ${runners.fallbackModel})`)})`
          : undefined,
        sql`(not exists (select 1 from review_triggers where review_id = ${reviews.id}) or ${dispatchOutbox.acknowledgedAt} is not null)`,
      ),
    )
    .orderBy(dispatchOutbox.createdAt)
    .limit(50);
  return rows.map((row) => ({
    version: 1,
    reviewId: row.publicId,
    repositoryId: row.repositoryPublicId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    submittedAt: row.createdAt.toISOString(),
  }));
}

/**
 * Mark the durable outbox entry after its review has been delivered to the
 * queue.
 */
export async function dispatched(database: Database, id: string) {
  publicIdSchema("review").parse(id);
  await database.db
    .update(dispatchOutbox)
    .set({ dispatchedAt: new Date() })
    .where(
      eq(
        dispatchOutbox.reviewId,
        sql`(select id from reviews where public_id = ${id})`,
      ),
    );
}

type RunnerReservation = {
  runner: typeof runners.$inferSelect;
  deadline: Date;
};

/**
 * Fence execution with a new review version and lease, preserving live
 * ownership and the four-attempt limit; resolve credentials only for the
 * snapshotted model endpoint.
 */
async function beginAttemptInTransaction(
  tx: Transaction,
  id: string,
  owner: string,
  leaseMs: number,
  reservation?: RunnerReservation,
) {
  const [row] = await tx
    .select()
    .from(reviews)
    .where(eq(reviews.publicId, id))
    .for("update");
  if (!row) throw new Error("review unavailable");
  if (row.status === "completed")
    return {
      kind: "completed" as const,
      result: reviewResultSchema.parse(row.result),
    };
  if (row.status === "failed") return { kind: "failed" as const };
  const now = new Date();
  const [previous] = await tx
    .select()
    .from(reviewAttempts)
    .where(
      and(
        eq(reviewAttempts.reviewId, row.id),
        eq(reviewAttempts.version, row.version),
      ),
    );
  if (previous?.status === "running" && previous.leaseUntil > now)
    return {
      kind: "busy" as const,
      retryAt: previous.leaseUntil.getTime() + 1000,
    };
  if (previous?.status === "running")
    await tx
      .update(reviewAttempts)
      .set({ status: "abandoned", finishedAt: now })
      .where(eq(reviewAttempts.id, previous.id));
  if (row.version >= 4) {
    await tx
      .update(reviews)
      .set({ status: "failed", finishedAt: now, updatedAt: now })
      .where(eq(reviews.id, row.id));
    return { kind: "failed" as const };
  }
  const [repo] = await tx
    .select({ publicId: repositories.publicId, status: repositories.status })
    .from(repositories)
    .where(eq(repositories.id, row.repositoryId));
  if (repo?.status !== "active") return { kind: "failed" as const };
  let agent:
    | {
        provider: ModelProvider;
        endpoint: string;
        model: string;
        reasoningEffort?: ReasoningEffort;
        apiKey: string;
      }
    | undefined;
  if (row.source.agent) {
    const [saved] = await tx
      .select({
        provider: agents.provider,
        endpoint: agents.endpoint,
        apiKey: agents.apiKey,
      })
      .from(agents)
      .where(eq(agents.publicId, row.source.agent.id))
      .for("share");
    // Never send a replacement credential to an endpoint saved before an edit.
    if (
      !saved?.apiKey ||
      saved.endpoint !== row.source.agent.endpoint ||
      saved.provider !== (row.source.agent.provider ?? "openai")
    ) {
      await tx
        .update(reviews)
        .set({ status: "failed", finishedAt: now, updatedAt: now })
        .where(eq(reviews.id, row.id));
      return { kind: "failed" as const };
    }
    agent = {
      provider: row.source.agent.provider ?? "openai",
      endpoint: row.source.agent.endpoint,
      model: row.source.agent.model,
      ...(row.source.agent.reasoningEffort
        ? { reasoningEffort: row.source.agent.reasoningEffort }
        : {}),
      apiKey: saved.apiKey,
    };
  }
  const [attempt] = await tx
    .insert(reviewAttempts)
    .values({
      publicId: publicId("attempt"),
      reviewId: row.id,
      version: row.version + 1,
      owner,
      status: "running",
      leaseUntil: new Date(
        Math.min(
          Date.now() + leaseMs,
          reservation?.deadline.getTime() ?? Infinity,
        ),
      ),
      ...(reservation
        ? {
            runnerId: reservation.runner.id,
            runnerSessionId: reservation.runner.sessionId!,
            deadline: reservation.deadline,
          }
        : {}),
    })
    .returning();
  await tx
    .update(reviews)
    .set({
      status: "running",
      version: attempt.version,
      startedAt: now,
      updatedAt: now,
    })
    .where(eq(reviews.id, row.id));
  return {
    kind: "started" as const,
    attemptId: attempt.publicId,
    leaseUntil: attempt.leaseUntil.getTime(),
    ...(reservation
      ? {
          runnerId: reservation.runner.publicId,
          sessionId: reservation.runner.sessionId!,
          capacity: reservation.runner.capacity,
          timeoutMs: reservation.runner.timeoutMs,
          deadline: reservation.deadline.getTime(),
        }
      : {}),
    source: row.source,
    ...(agent ? { agent } : {}),
    job: {
      version: 1 as const,
      reviewId: row.publicId,
      repositoryId: repo.publicId,
      baseSha: row.baseSha,
      headSha: row.headSha,
      submittedAt: row.createdAt.toISOString(),
      previousFindings: row.source.previousFindings,
      conversation: row.source.conversation,
      ...(row.source.guidance ? { guidance: row.source.guidance } : {}),
      ...(row.source.mcpServers ? { mcpServers: row.source.mcpServers } : {}),
    },
  };
}

/**
 * Acquire a durable attempt inside a transaction, returning existing
 * completion, failure or live ownership instead of starting duplicate work.
 */
export async function beginAttempt(
  database: Database,
  id: string,
  owner: string,
  leaseMs: number,
) {
  publicIdSchema("review").parse(id);
  return database.transaction((tx) =>
    beginAttemptInTransaction(tx, id, owner, leaseMs),
  );
}

/**
 * Build the shared availability predicate for ready runners with repository
 * access, a live session, spare capacity and any required model fallback.
 */
function eligibleRunner(
  repositoryId: string | typeof reviews.repositoryId,
  needsFallback: boolean | SQL,
) {
  return and(
    eq(runners.state, "enabled"),
    eq(runners.runtimeReady, true),
    eq(runners.protocolVersion, 1),
    sql`${runners.credentialHash} is not null`,
    sql`${runners.sessionId} is not null`,
    sql`${runners.sessionExpiresAt} > now()`,
    typeof needsFallback === "boolean"
      ? needsFallback
        ? eq(runners.fallbackModel, true)
        : undefined
      : needsFallback,
    or(
      eq(runners.allRepositories, true),
      sql`exists (select 1 from ${runnerRepositories} where ${runnerRepositories.runnerId} = ${runners.id} and ${runnerRepositories.repositoryId} = ${repositoryId})`,
    ),
    sql`(select count(*) from ${reviewAttempts} where ${reviewAttempts.runnerId} = ${runners.id} and ${reviewAttempts.runnerSessionId} = ${runners.sessionId} and ${reviewAttempts.status} = 'running' and ${reviewAttempts.leaseUntil} > now() and ${reviewAttempts.deadline} > now()) < ${runners.capacity}`,
  );
}

/**
 * Check whether unfinished work currently has an eligible runner; reservation
 * must still recheck under lock.
 */
export async function hasEligibleRunner(database: Database, reviewId: string) {
  publicIdSchema("review").parse(reviewId);
  const [review] = await database.db
    .select()
    .from(reviews)
    .where(eq(reviews.publicId, reviewId));
  if (!review || ["completed", "failed"].includes(review.status)) return false;
  const [runner] = await database.db
    .select({ id: runners.id })
    .from(runners)
    .where(eligibleRunner(review.repositoryId, !review.source.agent))
    .limit(1);
  return !!runner;
}

/**
 * Lock a review and eligible runner, recheck capacity after locking, then
 * reserve one versioned attempt; unavailable capacity consumes no attempt.
 */
export async function reserveEligibleRunnerAttempt(
  database: Database,
  reviewId: string,
  owner: string,
  leaseMs: number,
) {
  publicIdSchema("review").parse(reviewId);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000)
    throw new Error("Invalid attempt lease duration");
  return database.transaction(async (tx) => {
    const [review] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.publicId, reviewId))
      .for("update");
    if (!review) throw new Error("Review unavailable");
    if (review.status === "completed")
      return {
        kind: "completed" as const,
        result: reviewResultSchema.parse(review.result),
      };
    if (review.status === "failed") return { kind: "failed" as const };
    const [current] = await tx
      .select()
      .from(reviewAttempts)
      .where(
        and(
          eq(reviewAttempts.reviewId, review.id),
          eq(reviewAttempts.version, review.version),
        ),
      );
    if (current?.status === "running" && current.leaseUntil > new Date())
      return {
        kind: "busy" as const,
        retryAt: current.leaseUntil.getTime() + 1000,
      };
    const [runner] = await tx
      .select()
      .from(runners)
      .where(eligibleRunner(review.repositoryId, !review.source.agent))
      .orderBy(runners.lastSeenAt, runners.publicId)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!runner) return { kind: "unavailable" as const };
    // The row lock serializes reservations. Re-read capacity after obtaining it:
    // another transaction may have committed an attempt during candidate selection.
    const [eligible] = await tx
      .select({ id: runners.id })
      .from(runners)
      .where(
        and(
          eq(runners.id, runner.id),
          eligibleRunner(review.repositoryId, !review.source.agent),
        ),
      );
    if (!eligible) return { kind: "unavailable" as const };
    const deadline = new Date(Date.now() + runner.timeoutMs);
    const attempt = await beginAttemptInTransaction(
      tx,
      reviewId,
      owner,
      leaseMs,
      { runner, deadline },
    );
    return attempt.kind === "started"
      ? {
          ...attempt,
          runnerId: runner.publicId,
          sessionId: runner.sessionId!,
          capacity: runner.capacity,
          timeoutMs: runner.timeoutMs,
          deadline: deadline.getTime(),
        }
      : attempt;
  });
}

const registeredAttemptLive = sql`(${reviewAttempts.runnerId} is null or exists (
  select 1 from ${runners} where ${runners.id} = ${reviewAttempts.runnerId}
    and ${runners.sessionId} = ${reviewAttempts.runnerSessionId}
    and ${runners.state} <> 'revoked' and ${runners.credentialHash} is not null
    and ${runners.sessionExpiresAt} > clock_timestamp()
    and ${reviewAttempts.deadline} > clock_timestamp()
))`;

/**
 * Extend a still-owned lease up to its fixed deadline; return undefined for
 * expired, replaced or revoked session authority rather than reviving it.
 */
export async function renewRunnerAttempt(
  database: Database,
  runnerId: string,
  sessionId: string,
  reviewId: string,
  attemptId: string,
  owner: string,
  leaseMs: number,
) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000)
    throw new Error("Invalid attempt lease duration");
  return database.transaction(async (tx) => {
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
    const [runner] = await tx
      .select()
      .from(runners)
      .where(eq(runners.publicId, runnerId))
      .for("share");
    const now = new Date();
    if (
      !review ||
      !attempt ||
      !runner ||
      runner.state === "revoked" ||
      !runner.credentialHash ||
      runner.sessionId !== sessionId ||
      !runner.sessionExpiresAt ||
      runner.sessionExpiresAt <= now ||
      attempt.runnerId !== runner.id ||
      attempt.runnerSessionId !== sessionId ||
      attempt.reviewId !== review.id ||
      attempt.owner !== owner ||
      attempt.version !== review.version ||
      review.status !== "running" ||
      attempt.status !== "running" ||
      attempt.leaseUntil <= now ||
      !attempt.deadline ||
      attempt.deadline <= now
    )
      return undefined;
    const [repo] = await tx
      .select({ status: repositories.status })
      .from(repositories)
      .where(eq(repositories.id, review.repositoryId));
    if (repo?.status !== "active") return undefined;
    const leaseUntil = new Date(
      Math.min(now.getTime() + leaseMs, attempt.deadline.getTime()),
    );
    await tx
      .update(reviewAttempts)
      .set({ leaseUntil, updatedAt: now })
      .where(eq(reviewAttempts.id, attempt.id));
    await tx
      .update(reviews)
      .set({ updatedAt: now })
      .where(eq(reviews.id, review.id));
    return leaseUntil.getTime();
  });
}

/**
 * Check current review version, broker owner, repository state, lease and
 * registered runner session before accepting attempt activity. An existing transaction
 * can supply its connection so callers holding locks do not acquire another pool slot.
 * Wall-clock predicates reject authority that expired while the transaction waited.
 */
export async function ownsAttempt(
  database: Database,
  reviewId: string,
  attemptId: string,
  owner: string,
  transaction?: Transaction,
) {
  const [row] = await (transaction ?? database.db)
    .select({ publicId: reviewAttempts.publicId })
    .from(reviewAttempts)
    .innerJoin(
      reviews,
      and(
        eq(reviewAttempts.reviewId, reviews.id),
        eq(reviewAttempts.version, reviews.version),
      ),
    )
    .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
    .where(
      and(
        eq(repositories.status, "active"),
        eq(reviews.publicId, reviewId),
        eq(reviewAttempts.publicId, attemptId),
        eq(reviewAttempts.owner, owner),
        eq(reviews.status, "running"),
        eq(reviewAttempts.status, "running"),
        sql`${reviewAttempts.leaseUntil} > clock_timestamp()`,
        registeredAttemptLive,
      ),
    );
  return !!row;
}

/**
 * Persist a validated result or failure only for the current owner;
 * unsuccessful work can be requeued, while the trusted broker may record
 * deadline failure after lease expiry.
 */
export async function finishAttempt(
  database: Database,
  reviewId: string,
  attemptId: string,
  owner: string,
  result: unknown,
  terminal = false,
) {
  publicIdSchema("review").parse(reviewId);
  publicIdSchema("attempt").parse(attemptId);
  const validated =
    result === undefined ? undefined : reviewResultSchema.parse(result);
  return database.transaction(async (tx) => {
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
    // The trusted broker can record deadline failure after authority expires;
    // late successful results never bypass lease/session fencing.
    const expiredTerminal =
      validated === undefined &&
      terminal &&
      !!attempt?.runnerId &&
      !!attempt.deadline &&
      attempt.deadline <= new Date();
    if (
      !review ||
      !attempt ||
      attempt.reviewId !== review.id ||
      attempt.owner !== owner ||
      attempt.version !== review.version ||
      review.status !== "running" ||
      attempt.status !== "running" ||
      (attempt.leaseUntil <= new Date() && !expiredTerminal)
    )
      throw new Error("attempt lost durable ownership");
    const now = new Date();
    if (attempt.runnerId && !expiredTerminal) {
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
        runner.sessionExpiresAt <= now ||
        !attempt.deadline ||
        attempt.deadline <= now
      )
        throw new Error("attempt lost runner session ownership");
    }
    const [repository] = await tx
      .select({ status: repositories.status })
      .from(repositories)
      .where(eq(repositories.id, review.repositoryId));
    if (repository?.status !== "active")
      throw new Error("attempt repository unavailable");
    if (validated)
      validateFindingChecks(
        validated,
        review.source.previousFindings,
        !!review.source.conversation,
      );
    await tx
      .update(reviewAttempts)
      .set({
        status: validated ? "completed" : "failed",
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(reviewAttempts.id, attempt.id));
    const unsuccessfulStatus = terminal ? "failed" : "queued";
    await tx
      .update(reviews)
      .set({
        status: validated ? "completed" : unsuccessfulStatus,
        result: validated ?? null,
        finishedAt: validated || terminal ? now : null,
        updatedAt: now,
      })
      .where(eq(reviews.id, review.id));
  });
}

// Recover queue loss and crash-before-dispatch acknowledgement. Queue delivery
// cannot replace the durable attempt lease when deciding whether to redispatch.
/**
 * Recover stale outbox delivery and abandoned execution without stealing live
 * leases; fixed deadlines and exhausted attempts become terminal failures.
 */
export async function recoverDispatches(database: Database) {
  await database.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(reviews)
      .where(
        and(
          sql`${reviews.status} in ('queued','running')`,
          sql`exists (select 1 from repositories where id = ${reviews.repositoryId} and status = 'active')`,
          lt(reviews.updatedAt, new Date(Date.now() - 30000)),
        ),
      )
      .limit(50)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const [attempt] = await tx
        .select()
        .from(reviewAttempts)
        .where(
          and(
            eq(reviewAttempts.reviewId, row.id),
            eq(reviewAttempts.version, row.version),
          ),
        );
      if (
        row.status === "running" &&
        attempt?.status === "running" &&
        attempt.runnerId &&
        attempt.deadline &&
        attempt.deadline <= new Date()
      ) {
        const now = new Date();
        await tx
          .update(reviewAttempts)
          .set({ status: "failed", finishedAt: now, updatedAt: now })
          .where(eq(reviewAttempts.id, attempt.id));
        await tx
          .update(reviews)
          .set({ status: "failed", finishedAt: now, updatedAt: now })
          .where(eq(reviews.id, row.id));
        continue;
      }
      if (attempt?.status === "running") {
        const [live] = await tx
          .select({ id: reviewAttempts.id })
          .from(reviewAttempts)
          .where(and(eq(reviewAttempts.id, attempt.id), registeredAttemptLive));
        if (live && attempt.leaseUntil > new Date()) continue;
        // A revoked, replaced, or expired process cannot revive its reservation.
        // Expire it before redispatch so the next runner can acquire a new version.
        await tx
          .update(reviewAttempts)
          .set({
            status: "abandoned",
            leaseUntil: new Date(),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reviewAttempts.id, attempt.id));
        const exhausted = row.version >= 4;
        await tx
          .update(reviews)
          .set({
            status: exhausted ? "failed" : "queued",
            finishedAt: exhausted ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(reviews.id, row.id));
        if (exhausted) continue;
      }
      await tx
        .update(dispatchOutbox)
        .set({ dispatchedAt: null })
        .where(eq(dispatchOutbox.reviewId, row.id));
    }
  });
}
