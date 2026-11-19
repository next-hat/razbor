import { desc, eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "@database/src/connection.js";
import {
  dispatchOutbox,
  pullRequests,
  repositories,
  reviews,
  reviewTriggers,
} from "@database/src/schema.js";

/** Revisit decisions after policy or source edits. A changed source requires fresh reviews even for unchanged commits. */
export async function wakeRepositoryTriage(
  tx: Transaction,
  repositoryId: string,
  sourceChanged = false,
) {
  await tx
    .update(pullRequests)
    .set({
      mergeAfter: new Date(),
      ...(sourceChanged
        ? { mergeRevision: sql`${pullRequests.mergeRevision} + 1` }
        : {}),
    })
    .where(eq(pullRequests.repositoryId, repositoryId));
}

/** Select only the latest code review associated with this provider PR, across every trigger mode. */
export function latestMergeReview(
  db: Pick<Database["db"], "select">,
  prId: string,
) {
  return db
    .select({
      review: reviews,
      publication: dispatchOutbox.publication,
      trigger: reviewTriggers.change,
    })
    .from(reviews)
    .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
    .leftJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .where(eq(reviews.mergePullRequestId, prId))
    .orderBy(desc(reviews.createdAt), desc(reviews.publicId))
    .limit(1);
}

/** Re-read the same repository, PR and current review under locks shared by admission and policy editing. */
export async function withCurrentMergeReview<T>(
  database: Database,
  repo: typeof repositories.$inferSelect,
  pr: typeof pullRequests.$inferSelect,
  review: typeof reviews.$inferSelect,
  apply: (tx: Transaction) => Promise<T>,
) {
  return database.transaction(async (tx) => {
    // A bounded provider request can span several HTTP calls; keep the lock through its acknowledgement.
    await tx.execute(
      sql`set local idle_in_transaction_session_timeout = '90s'`,
    );
    const [owner] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo.id))
      .for("share");
    if (
      owner?.status !== "active" ||
      owner.version !== repo.version ||
      owner.verifiedAt?.getTime() !== repo.verifiedAt?.getTime()
    )
      return;
    const [current] = await tx
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, pr.id))
      .for("update");
    if (!current || current.mergeRevision !== pr.mergeRevision) return;
    const [latest] = await latestMergeReview(tx, pr.id);
    if (
      latest?.review.id !== review.id ||
      latest.review.status !== review.status ||
      latest.review.source.mergeRevision !== review.source.mergeRevision
    )
      return;
    return apply(tx);
  });
}
