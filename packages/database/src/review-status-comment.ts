import { eq, sql } from "drizzle-orm";

import { ForgeOperationError, type Forge } from "@razbor/forge-adapters";
import { logger } from "@razbor/harness/logger";

import type { Database } from "@database/src/connection.js";
import {
  dispatchOutbox,
  repositories,
  repositoryWebhooks,
  reviews,
  reviewTriggers,
  type ReviewStatusComment,
} from "@database/src/schema.js";

/** Select changed activity or safely finished publications that still own a status comment. */
export function statusCommentDue() {
  return sql`(${dispatchOutbox.statusAfter} is null or ${dispatchOutbox.statusAfter} <= now())
    and ${reviews.source}->'conversation' is null
    and ((${reviews.status} in ('queued', 'running')
      and (${dispatchOutbox.statusComment}->>'shown' is distinct from ${reviews.status}
        or ${dispatchOutbox.statusComment}->>'headSha' is distinct from ${reviews.headSha}))
      or (${reviews.status} in ('completed', 'failed')
        and (${dispatchOutbox.publication}->>'state' in ('published', 'stale')
          or ${dispatchOutbox.statusComment}->>'shown' is distinct from ${reviews.status})
        and ${dispatchOutbox.statusComment} is not null))`;
}

/** Render only server-owned data. A callback endpoint need not expose the console. */
function statusBody(
  reviewId: string,
  phase: typeof reviews.$inferSelect.status,
  head: string,
  marker: string,
) {
  const message = {
    queued: "Razbor review queued. Waiting for an available runner.",
    running: "Razbor is reviewing this pull request.",
    completed:
      "Razbor finished reviewing this pull request. Final publication is pending.",
    failed:
      "Razbor could not complete this review. Failure notification is pending.",
  }[phase];
  const base = process.env.RAZBOR_PUBLIC_URL;
  let link = "";
  if (base && URL.canParse(base)) {
    const url = new URL(base);
    if (url.protocol === "https:" && !url.username && !url.password)
      link = ` [View review](<${new URL(`/jobs/${reviewId}`, url).href}>).`;
  }
  return `${message}\n\nCommit \`${head.slice(0, 12)}\`.${link}\n\n${marker}`;
}

/**
 * Reconcile one review under its repository interaction lock. The outbox owns
 * the only ID that may be edited or deleted. An uncertain first POST is read
 * back by its exact saved body and bot on the same PR before any further write.
 */
export async function syncStatusComment(
  database: Database,
  reviewId: string,
  currentBotId: string | null,
  adapter: () => Promise<Forge>,
  retire = false,
  deleting = false,
) {
  const [entry] = await database.db
    .select({
      outboxId: dispatchOutbox.id,
      saved: dispatchOutbox.statusComment,
      phase: reviews.status,
      head: reviews.headSha,
      publication: dispatchOutbox.publication,
      change: reviewTriggers.change,
    })
    .from(dispatchOutbox)
    .innerJoin(reviews, eq(reviews.id, dispatchOutbox.reviewId))
    .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .where(
      sql`${reviews.publicId} = ${reviewId} and (${retire ? sql`${dispatchOutbox.statusComment} is not null` : statusCommentDue()})`,
    );
  if (!entry) return;
  const { phase, head, change } = entry;
  const terminal = phase === "completed" || phase === "failed";
  const remove =
    retire ||
    (terminal &&
      ["published", "stale"].includes(entry.publication?.state ?? ""));
  const marker = `<!-- razbor:${reviewId}:status -->`;
  const botId = entry.saved?.botId ?? currentBotId;
  if (!botId) return;
  let state: ReviewStatusComment = entry.saved ?? { botId };

  /** Persist the write fence independently from acknowledgement and publication retry deadlines. */
  async function save(value: ReviewStatusComment | null, retry = false) {
    await database.db
      .update(dispatchOutbox)
      .set({
        statusComment: value,
        statusAfter: retry ? new Date(Date.now() + 30000) : null,
      })
      .where(eq(dispatchOutbox.id, entry.outboxId));
  }

  try {
    if ((retire || terminal) && !state.creatingBody && !state.remoteId) {
      await save(null);
      return;
    }
    const api = await adapter();
    if (
      (currentBotId && currentBotId !== botId) ||
      (await api.identity()).id !== botId
    )
      throw new ForgeOperationError("permission");

    if (state.creatingBody) {
      const matches = (
        await api.comments(change.number, { complete: true })
      ).filter(
        (comment) =>
          comment.user.id === state.botId &&
          comment.body === state.creatingBody &&
          comment.body.endsWith(`\n${marker}`),
      );
      if (matches.length !== 1)
        throw new ForgeOperationError("unavailable", true);
      state = { ...state, remoteId: matches[0].id, creatingBody: undefined };
      await save(state);
    }

    if (remove) {
      if (state.remoteId)
        await api.deleteStatusComment(
          change.number,
          state.remoteId,
          botId,
          marker,
        );
      await save(null);
      return;
    }
    // A runner may finish or a queued head may be coalesced during a forge read.
    const [latest] = await database.db
      .select({ phase: reviews.status, head: reviews.headSha })
      .from(reviews)
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
      .innerJoin(
        repositoryWebhooks,
        eq(repositoryWebhooks.id, reviewTriggers.webhookId),
      )
      .where(
        sql`${reviews.publicId} = ${reviewId} and ${repositories.status} = 'active' and ${repositoryWebhooks.enabled}`,
      );
    if (latest?.phase !== phase || latest.head !== head) return;
    const body = statusBody(reviewId, phase, head, marker);
    if (state.remoteId) {
      await api.editStatusComment(
        change.number,
        state.remoteId,
        botId,
        marker,
        body,
      );
    } else {
      state = { botId, creatingBody: body };
      await save(state);
      try {
        const remoteId = await api.postComment(change.number, body);
        state = { botId, remoteId };
      } catch (error) {
        // A definitive rejection permits a fresh POST. A transport or unknown
        // error retains the exact creation fence, including across restarts.
        if (error instanceof ForgeOperationError && !error.uncertain)
          state = { botId };
        throw error;
      }
    }
    await save({
      botId,
      remoteId: state.remoteId,
      shown: phase,
      headSha: head,
    });
  } catch (error) {
    const reason =
      error instanceof ForgeOperationError ? error.reason : "unavailable";
    await save(
      { ...state, error: reason, retirementAttempted: deleting || undefined },
      true,
    );
    logger.warn(
      { reviewId, reason },
      "review status comment reconciliation deferred",
    );
  }
}
