import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { publicIdSchema } from "@razbor/contracts";

import type { Database, Transaction } from "@database/src/connection.js";
import {
  repositories,
  indexWorkspaces,
  indexAccessTokens,
  indexAccessTokenWorkspaces,
  reviews,
  reviewAttempts,
  reviewTriggers,
  repositoryWebhooks,
  webhookDeliveries,
  dispatchOutbox,
} from "@database/src/schema.js";

/**
 * Group repositories awaiting deletion with their public review IDs for queue
 * cleanup.
 */
export async function listDeletingRepositories(database: Database) {
  const rows = await database.db
    .select({
      id: repositories.publicId,
      reviewId: reviews.publicId,
    })
    .from(repositories)
    .leftJoin(reviews, eq(reviews.repositoryId, repositories.id))
    .where(eq(repositories.status, "deleting"))
    .orderBy(repositories.updatedAt, repositories.publicId);
  const deleting = new Map<string, { id: string; reviewIds: string[] }>();
  for (const row of rows) {
    const repository = deleting.get(row.id) ?? { id: row.id, reviewIds: [] };
    if (row.reviewId) repository.reviewIds.push(row.reviewId);
    deleting.set(row.id, repository);
  }
  return [...deleting.values()];
}

/**
 * Record a safe retry message only while repository deletion remains in
 * progress.
 */
export async function repositoryDeletionError(
  database: Database,
  repositoryId: string,
) {
  publicIdSchema("repository").parse(repositoryId);
  await database.db
    .update(repositories)
    .set({
      setupError:
        "Cleanup will retry. Check service availability and the forge token's webhook permissions.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositories.publicId, repositoryId),
        eq(repositories.status, "deleting"),
      ),
    );
}

/**
 * Move shared tokens to a surviving granted workspace before deleting their
 * primary binding; remove tokens with no surviving grant.
 */
async function reassignWorkspaceTokens(
  tx: Transaction,
  workspaces: (typeof indexWorkspaces.$inferSelect)[],
) {
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const tokens = await tx
    .select()
    .from(indexAccessTokens)
    .where(inArray(indexAccessTokens.workspaceId, workspaceIds))
    .for("update");
  for (const token of tokens) {
    const primary = workspaces.find(
      (workspace) => workspace.id === token.workspaceId,
    )!;
    const [replacement] = await tx
      .select({ id: indexWorkspaces.id })
      .from(indexWorkspaces)
      .innerJoin(
        repositories,
        eq(indexWorkspaces.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(indexWorkspaces.owner, primary.owner),
          eq(indexWorkspaces.temporary, false),
          isNull(indexWorkspaces.expiresAt),
          sql`${indexWorkspaces.state} in ('ready','unready')`,
          eq(repositories.status, "active"),
          or(
            sql`${token.allRepositories}`,
            sql`exists (select 1 from ${indexAccessTokenWorkspaces}
            where ${indexAccessTokenWorkspaces.tokenId} = ${token.id}
              and ${indexAccessTokenWorkspaces.workspaceId} = ${indexWorkspaces.id})`,
          ),
        ),
      )
      .orderBy(indexWorkspaces.publicId)
      .limit(1)
      .for("share", { of: indexWorkspaces });
    if (replacement) {
      await tx
        .update(indexAccessTokens)
        .set({ workspaceId: replacement.id, updatedAt: new Date() })
        .where(eq(indexAccessTokens.id, token.id));
      await tx
        .delete(indexAccessTokenWorkspaces)
        .where(
          and(
            eq(indexAccessTokenWorkspaces.tokenId, token.id),
            eq(indexAccessTokenWorkspaces.workspaceId, replacement.id),
          ),
        );
    } else {
      await tx
        .delete(indexAccessTokenWorkspaces)
        .where(eq(indexAccessTokenWorkspaces.tokenId, token.id));
      await tx
        .delete(indexAccessTokens)
        .where(eq(indexAccessTokens.id, token.id));
    }
  }
  await tx
    .delete(indexAccessTokenWorkspaces)
    .where(inArray(indexAccessTokenWorkspaces.workspaceId, workspaceIds));
}

// Called only after queue jobs and the owned provider webhook have been removed.
// Filesystem cleanup is acknowledged by the indexer's durable workspace states.
/**
 * Delete repository-owned database state once workspace, webhook and attempt
 * cleanup is complete; return false while cleanup or another deletion worker
 * is active.
 */
export async function finishRepositoryDeletion(
  database: Database,
  repositoryId: string,
) {
  publicIdSchema("repository").parse(repositoryId);
  return database.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(748323, hashtext(${repositoryId})) as locked`,
    );
    if (!lock.rows[0]?.locked) return false;
    const [repository] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.publicId, repositoryId))
      .for("update");
    if (!repository) return true;
    if (repository.status !== "deleting") return false;
    const workspaces = await tx
      .select()
      .from(indexWorkspaces)
      .where(eq(indexWorkspaces.repositoryId, repository.id))
      .for("update");
    if (workspaces.some((workspace) => workspace.state !== "deleted"))
      return false;
    const [hook] = await tx
      .select()
      .from(repositoryWebhooks)
      .where(eq(repositoryWebhooks.repositoryId, repository.id));
    if (hook?.remoteId) return false;
    const reviewRows = await tx
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.repositoryId, repository.id));
    const reviewIds = reviewRows.map((review) => review.id);
    if (reviewIds.length) {
      const [running] = await tx
        .select({ id: reviewAttempts.id })
        .from(reviewAttempts)
        .where(
          and(
            inArray(reviewAttempts.reviewId, reviewIds),
            eq(reviewAttempts.status, "running"),
          ),
        )
        .limit(1);
      if (running) return false;
    }
    const workspaceIds = workspaces.map((workspace) => workspace.id);
    if (workspaceIds.length) {
      await reassignWorkspaceTokens(tx, workspaces);
    }
    const tables = await tx.execute<{ present: boolean }>(
      sql`select to_regclass('public.embedding_indexes') is not null as present`,
    );
    if (tables.rows[0]?.present) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(748322, hashtext(${repository.id}))`,
      );
      await tx.execute(
        sql`delete from embedding_indexes where repository_id = ${repository.id}::uuid`,
      );
      await tx.execute(
        sql`delete from embedding_cache where repository_id = ${repository.id}::uuid`,
      );
    }
    await tx
      .delete(indexWorkspaces)
      .where(eq(indexWorkspaces.repositoryId, repository.id));
    await tx
      .delete(reviewTriggers)
      .where(eq(reviewTriggers.repositoryId, repository.id));
    if (hook)
      await tx
        .delete(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hook.id));
    await tx
      .delete(repositoryWebhooks)
      .where(eq(repositoryWebhooks.repositoryId, repository.id));
    if (reviewIds.length) {
      await tx
        .delete(dispatchOutbox)
        .where(inArray(dispatchOutbox.reviewId, reviewIds));
      await tx
        .delete(reviewAttempts)
        .where(inArray(reviewAttempts.reviewId, reviewIds));
      await tx.delete(reviews).where(inArray(reviews.id, reviewIds));
    }
    // Stored credentials are repository-owned and cascade; shared forge settings remain.
    await tx.delete(repositories).where(eq(repositories.id, repository.id));
    return true;
  });
}
