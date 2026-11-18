import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { PreviousFinding, ReviewConversation } from "@razbor/contracts";
import type {
  ForgeChange,
  ForgeType,
  ForgeWebhook,
} from "@razbor/forge-adapters";

import { snapshotRepositoryAgent } from "@database/src/agents.js";
import type { Database, Transaction } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import { snapshotRepositoryMcpServers } from "@database/src/mcp.js";
import { rearmStalePublication } from "@database/src/rearm-publication.js";
import {
  dispatchOutbox,
  pullRequests,
  repositories,
  repositoryWebhooks,
  reviews,
  reviewTriggers,
  webhookDeliveries,
} from "@database/src/schema.js";
import { snapshotRepositoryGuidance } from "@database/src/skills.js";

const supersededPublication = {
  state: "stale",
  stale: true,
  error:
    "Automatic review superseded by a newer revision, pull request state, or trigger policy.",
} as const;

type ChangeEvent = Exclude<ForgeWebhook, { kind: "ping" | "push" }>;

type Observation = {
  event: ChangeEvent;
  change?: ForgeChange;
  generation: number;
  previous?: PreviousFinding[];
  conversation?: ReviewConversation;
  commandAt?: string;
};

/** Match a provider change by its repository-scoped number, including records predating trigger modes. */
function sameChange(repositoryId: string, number?: number) {
  return and(
    eq(reviewTriggers.repositoryId, repositoryId),
    number === undefined
      ? undefined
      : sql`${reviewTriggers.change}->>'number' = ${String(number)}`,
  );
}

/** Retire queued automatic work atomically with its publication, leaving running attempts and historical results alone. */
export async function supersedeQueuedAutomaticReviews(
  tx: Transaction,
  repositoryId: string,
  number?: number,
  except?: string,
) {
  const changed = await tx
    .update(reviews)
    .set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(reviews.status, "queued"),
        except ? sql`${reviews.id} <> ${except}` : undefined,
        inArray(
          reviews.id,
          tx
            .select({ id: reviewTriggers.reviewId })
            .from(reviewTriggers)
            .where(
              and(
                sameChange(repositoryId, number),
                eq(reviewTriggers.origin, "automatic"),
              ),
            ),
        ),
      ),
    )
    .returning({ id: reviews.id });
  if (changed.length)
    await tx
      .update(dispatchOutbox)
      .set({
        publication: supersededPublication,
        interactionAfter: new Date(),
      })
      .where(
        inArray(
          dispatchOutbox.reviewId,
          changed.map((row) => row.id),
        ),
      );
}

/** Reset opt-ins and retire waiting automatic jobs under the caller's owning repository lock when policy changes. */
export async function resetRepositoryReviewTriggers(
  tx: Transaction,
  repositoryId: string,
) {
  await tx
    .update(pullRequests)
    .set({
      continuousReviewSince: null,
      reviewSessionResetAt: new Date(),
      triggerGeneration: sql`${pullRequests.triggerGeneration}+1`,
    })
    .where(eq(pullRequests.repositoryId, repositoryId));
  await supersedeQueuedAutomaticReviews(tx, repositoryId);
}

/** Read the observation generation before provider I/O. A concurrent webhook commit requires fresh provider data. */
export async function reviewTriggerSession(
  database: Database,
  repositoryId: string,
  number: number,
) {
  const [session] = await database.db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, number),
      ),
    );
  return session;
}

/** Snapshot a verified provider change and route both origins through the same immutable attempt and publication pipeline. */
async function queueReview(
  tx: Transaction,
  repo: typeof repositories.$inferSelect,
  hookId: string,
  forge: ForgeType,
  change: ForgeChange,
  observation: Observation,
) {
  const { event, previous, conversation } = observation;
  const automatic = event.kind !== "comment";
  // This transaction holds the repository's webhook row lock. The review row lock also
  // fences runner reservation: only an unstarted review may receive a new revision.
  let queued: typeof reviews.$inferSelect | undefined;
  if (automatic) {
    const [existing] = await tx
      .select({
        id: reviews.id,
        status: reviews.status,
        triggerId: reviewTriggers.id,
      })
      .from(reviews)
      .leftJoin(reviewTriggers, eq(reviews.id, reviewTriggers.reviewId))
      .where(
        and(
          eq(reviews.repositoryId, repo.id),
          eq(reviews.headSha, change.headSha),
          eq(reviews.baseSha, change.mergeBase),
          or(
            and(
              sameChange(repo.id, change.number),
              sql`${reviewTriggers.change}->>'baseSha' = ${change.baseSha}`,
              sql`${reviewTriggers.change}->>'startSha' is not distinct from ${change.startSha ?? null}`,
            ),
            and(
              isNull(reviewTriggers.reviewId),
              sql`${reviews.source}->'pullRequest'->>'number' = ${String(change.number)} and ${reviews.source}->'pullRequest'->>'baseSha' = ${change.baseSha}`,
            ),
          ),
          sql`${reviews.source}->>'conversation' is null`,
          inArray(reviews.status, ["queued", "running", "completed"]),
        ),
      )
      .orderBy(desc(reviews.createdAt), desc(reviews.publicId))
      .limit(1);
    if (existing) {
      await supersedeQueuedAutomaticReviews(
        tx,
        repo.id,
        change.number,
        existing.id,
      );
      if (existing.status === "completed" && existing.triggerId)
        await rearmStalePublication(tx, existing.id);
      return undefined;
    }
    const [pending] = await tx
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
      .where(
        and(
          sameChange(repo.id, change.number),
          eq(reviewTriggers.origin, "automatic"),
          eq(reviews.status, "queued"),
          eq(reviews.version, 0),
        ),
      )
      .limit(1)
      .for("update", { of: reviews });
    queued = pending?.review;
    // Retire a previous revision already waiting for a retry even when its old
    // model assignment can no longer get a runner. A live attempt stays pinned.
    await supersedeQueuedAutomaticReviews(
      tx,
      repo.id,
      change.number,
      queued?.id,
    );
  }
  const git = structuredClone(repo.git);
  const remote = git.upstream.split("/")[2];
  const ref =
    forge === "gitlab"
      ? `refs/merge-requests/${change.number}/head`
      : `refs/pull/${change.number}/head`;
  git.extra_fetch_refs[remote] = [
    ...new Set([...(git.extra_fetch_refs[remote] ?? []), ref]),
  ];
  const agent = await snapshotRepositoryAgent(tx, repo.agentId, repo.contextId);
  const guidance = await snapshotRepositoryGuidance(
    tx,
    repo.guidance,
    repo.contextId,
  );
  const mcpServers = await snapshotRepositoryMcpServers(tx, repo.id);
  const values = {
    repositoryId: repo.id,
    baseSha: change.mergeBase,
    headSha: change.headSha,
    source: {
      configKey: repo.configKey,
      git,
      indexOwner: repo.indexOwner,
      ...(agent ? { agent } : {}),
      ...(guidance ? { guidance } : {}),
      ...(mcpServers.length ? { mcpServers } : {}),
      previousFindings: previous,
      conversation,
    },
  };
  if (queued) {
    await tx
      .update(reviews)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(reviews.id, queued.id));
    await tx
      .update(reviewTriggers)
      .set({ change })
      .where(eq(reviewTriggers.reviewId, queued.id));
    await tx
      .update(dispatchOutbox)
      .set({ interactionAfter: new Date() })
      .where(eq(dispatchOutbox.reviewId, queued.id));
    return queued.publicId;
  }
  const [review] = await tx
    .insert(reviews)
    .values({ ...values, publicId: publicId("review") })
    .returning();
  await tx.insert(reviewTriggers).values({
    webhookId: hookId,
    repositoryId: repo.id,
    reviewId: review.id,
    origin: automatic ? "automatic" : "manual",
    commentId: event.kind === "comment" ? event.commentId : null,
    change,
  });
  await tx.insert(dispatchOutbox).values({
    reviewId: review.id,
    publication: { state: "pending" },
    acknowledgedAt: automatic ? new Date() : null,
  });
  return review.publicId;
}

/**
 * Fence observations against policy, webhook and PR changes, then atomically save the delivery,
 * activation/reset, review and outbox. A racing observation must refetch before recording its delivery.
 */
export async function acceptReviewTrigger(
  database: Database,
  repo: typeof repositories.$inferSelect,
  hook: typeof repositoryWebhooks.$inferSelect,
  forge: ForgeType,
  observation: Observation,
) {
  const { event, change } = observation;
  return database.transaction(async (tx) => {
    const [active] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo.id))
      .for("share");
    if (
      !active ||
      active.status !== "active" ||
      !active.verifiedAt ||
      active.version !== repo.version ||
      active.externalRepositoryId !== event.repositoryId ||
      active.reviewTriggerMode !== repo.reviewTriggerMode
    )
      throw new Error("Repository policy changed");
    const [current] = await tx
      .select()
      .from(repositoryWebhooks)
      .where(eq(repositoryWebhooks.id, hook.id))
      .for("update");
    if (
      !current?.enabled ||
      current.updatedAt.getTime() !== hook.updatedAt.getTime()
    )
      throw new Error("Webhook policy changed");
    const scope = and(
      eq(pullRequests.repositoryId, repo.id),
      eq(pullRequests.number, event.number),
    );
    const [session] = await tx
      .select()
      .from(pullRequests)
      .where(scope)
      .for("update");
    if ((session?.triggerGeneration ?? 0) !== observation.generation)
      return { retry: true } as const;
    const received = await tx
      .insert(webhookDeliveries)
      .values({ webhookId: hook.id, deliveryId: event.deliveryId })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });
    if (!received.length) return { duplicate: true } as const;
    await tx
      .update(repositoryWebhooks)
      .set({ lastDelivery: "accepted", lastDeliveryAt: new Date() })
      .where(eq(repositoryWebhooks.id, hook.id));
    if (event.kind === "comment") {
      const [prior] = await tx
        .select({ id: reviews.publicId })
        .from(reviewTriggers)
        .innerJoin(reviews, eq(reviews.id, reviewTriggers.reviewId))
        .where(
          and(
            eq(reviewTriggers.repositoryId, repo.id),
            eq(reviewTriggers.commentId, event.commentId),
          ),
        );
      if (prior) return { duplicate: true } as const;
    }
    let since = session?.continuousReviewSince ?? null;
    let reset = session?.reviewSessionResetAt ?? null;
    if (!change || event.kind === "closed" || event.kind === "reopened") {
      // A delayed close/reopen cannot revoke an opt-in posted in a later open session.
      const boundary =
        event.kind !== "comment" && event.occurredAt
          ? new Date(event.occurredAt)
          : new Date();
      if (!reset || reset < boundary) reset = boundary;
      if (!change || (since && since <= reset)) since = null;
    }
    if (
      change &&
      event.kind === "comment" &&
      !observation.conversation &&
      active.reviewTriggerMode === "opt_in_continuous"
    ) {
      const posted = observation.commandAt
        ? new Date(observation.commandAt)
        : undefined;
      if (!reset || (posted && posted > reset)) {
        const activated = posted ?? new Date();
        if (!since || activated > since) since = activated;
      }
    }
    const now = new Date();
    // Equal-head deliveries can share an observation generation. Only changes
    // affecting eligibility or the diff invalidate another request's provider read.
    const changed =
      !session ||
      session.state !== (change ? "open" : "closed") ||
      (change &&
        (session.headSha !== change.headSha ||
          session.baseSha !== change.baseSha ||
          session.mergeBase !== change.mergeBase ||
          session.startSha !== (change.startSha ?? null) ||
          session.draft !== (change.draft ?? null))) ||
      session.continuousReviewSince?.getTime() !== since?.getTime() ||
      session.reviewSessionResetAt?.getTime() !== reset?.getTime();
    const sessionValues = {
      continuousReviewSince: since,
      reviewSessionResetAt: reset,
      triggerGeneration: observation.generation + (changed ? 1 : 0),
      syncedAt: now,
      updatedAt: now,
    };
    if (change) {
      const values = {
        ...sessionValues,
        number: event.number,
        draft: change.draft ?? null,
        mergeBase: change.mergeBase,
        startSha: change.startSha ?? null,
        title: change.title,
        url: change.url,
        state: "open" as const,
        author: change.author ?? null,
        headSha: change.headSha,
        baseSha: change.baseSha,
        headBranch: change.headBranch ?? null,
        baseBranch: change.baseBranch ?? null,
      };
      await tx
        .insert(pullRequests)
        .values({
          ...values,
          publicId: publicId("pullRequest"),
          repositoryId: repo.id,
        })
        .onConflictDoUpdate({
          target: [pullRequests.repositoryId, pullRequests.number],
          set: values,
        });
    } else if (session) {
      await tx
        .update(pullRequests)
        .set({ ...sessionValues, state: "closed" })
        .where(scope);
    }
    const automaticAllowed =
      active.reviewTriggerMode === "automatic" ||
      (active.reviewTriggerMode === "opt_in_continuous" && since !== null);
    if (
      !change ||
      (event.kind !== "comment" &&
        (!automaticAllowed || change.draft !== false))
    ) {
      await supersedeQueuedAutomaticReviews(tx, repo.id, event.number);
      return {} as const;
    }
    // Forgejo reports an edited title and the resulting draft flag. An
    // unchanged, already-ready snapshot is an ordinary rename.
    if (forge === "forgejo" && event.kind === "ready" && !changed)
      return { reviewId: undefined } as const;
    const reviewId = await queueReview(
      tx,
      active,
      hook.id,
      forge,
      change,
      observation,
    );
    return { reviewId } as const;
  });
}

/**
 * Hold a newer automatic revision until an older automatic attempt (including its retries) reaches a terminal state.
 * The runner rechecks this condition after locking its review; a claimed queue message carries only the stable job identity.
 */
export function automaticReviewReady() {
  return sql`not exists (
    select 1 from review_triggers candidate
    join review_triggers other on other.repository_id = candidate.repository_id
      and other.change->>'number' = candidate.change->>'number' and other.origin = 'automatic'
    join reviews busy on busy.id = other.review_id and busy.id <> candidate.review_id
    where candidate.review_id = ${reviews.id} and candidate.origin = 'automatic'
      and busy.version > 0 and busy.status in ('queued','running')
  )`;
}

/** Finish a discarded automatic retry without consuming another attempt. The caller holds the review row. */
export async function retireObsoleteAutomaticRetry(
  tx: Transaction,
  review: typeof reviews.$inferSelect,
) {
  const [obsolete] = await tx
    .select({ id: reviewTriggers.id })
    .from(reviewTriggers)
    .innerJoin(repositories, eq(repositories.id, reviewTriggers.repositoryId))
    .innerJoin(
      pullRequests,
      and(
        eq(pullRequests.repositoryId, repositories.id),
        sql`${pullRequests.number}::text = ${reviewTriggers.change}->>'number'`,
      ),
    )
    .where(
      and(
        eq(reviewTriggers.reviewId, review.id),
        eq(reviewTriggers.origin, "automatic"),
        sql`(${pullRequests.state} <> 'open' or ${pullRequests.draft} is distinct from false
        or ${pullRequests.headSha} <> ${review.headSha}
        or ${pullRequests.baseSha} <> ${reviewTriggers.change}->>'baseSha'
        or ${pullRequests.mergeBase} is distinct from ${review.baseSha}
        or ${pullRequests.startSha} is distinct from ${reviewTriggers.change}->>'startSha'
        or ${repositories.reviewTriggerMode} = 'manual'
        or (${repositories.reviewTriggerMode} = 'opt_in_continuous' and ${pullRequests.continuousReviewSince} is null))`,
      ),
    );
  if (!obsolete) return false;
  const now = new Date();
  await tx
    .update(reviews)
    .set({ status: "failed", finishedAt: now, updatedAt: now })
    .where(eq(reviews.id, review.id));
  await tx
    .update(dispatchOutbox)
    .set({ publication: supersededPublication, interactionAfter: now })
    .where(eq(dispatchOutbox.reviewId, review.id));
  return true;
}
