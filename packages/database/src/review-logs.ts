import { and, asc, count, eq, gt, max } from "drizzle-orm";

import {
  publicIdSchema,
  reviewLogSchema,
  type ReviewProgress,
} from "@razbor/contracts";

import type { Database } from "@database/src/connection.js";
import { ownsAttempt } from "@database/src/reviews.js";
import {
  repositories,
  reviewAttempts,
  reviewLogs as logs,
  reviews,
  runners,
} from "@database/src/schema.js";

/**
 * Append validated progress only for the current broker-owned attempt. Review and
 * attempt locks serialize logs with completion and retries, preserve resume cursors,
 * and cap each attempt at its first 500 records. Expired ownership returns false;
 * reaching the cap acknowledges the event without growing storage.
 */
export async function appendReviewLog(
  database: Database,
  reviewId: string,
  attemptId: string,
  owner: string,
  event: ReviewProgress,
): Promise<boolean> {
  publicIdSchema("review").parse(reviewId);
  publicIdSchema("attempt").parse(attemptId);
  const validated = reviewLogSchema.parse({ ...event, attemptId });
  return database.transaction(async (tx) => {
    const [review] = await tx
      .select({ id: reviews.id, repositoryId: reviews.repositoryId })
      .from(reviews)
      .where(eq(reviews.publicId, reviewId))
      .for("update");
    if (!review) return false;
    const [attempt] = await tx
      .select({ id: reviewAttempts.id, runnerId: reviewAttempts.runnerId })
      .from(reviewAttempts)
      .where(eq(reviewAttempts.publicId, attemptId))
      .for("update");
    if (!attempt) return false;
    if (attempt.runnerId)
      await tx
        .select({ id: runners.id })
        .from(runners)
        .where(eq(runners.id, attempt.runnerId))
        .for("share");
    await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.id, review.repositoryId))
      .for("share");
    if (!(await ownsAttempt(database, reviewId, attemptId, owner, tx)))
      return false;
    const [saved] = await tx
      .select({ count: count() })
      .from(logs)
      .where(eq(logs.attemptId, attempt.id));
    if (saved!.count >= 500) return true;
    const [last] = await tx
      .select({ sequence: max(logs.sequence) })
      .from(logs)
      .where(eq(logs.reviewId, review.id));
    await tx.insert(logs).values({
      reviewId: review.id,
      attemptId: attempt.id,
      sequence: (last?.sequence ?? 0) + 1,
      event: validated,
    });
    return true;
  });
}

/**
 * Read one bounded page after a per-review SSE cursor. A single snapshot includes
 * the current total, so logs appended concurrently cannot make a page appear caught
 * up prematurely. Callers remain responsible for repository authorization.
 */
export async function reviewLogs(
  database: Database,
  reviewId: string,
  cursor: number,
  limit = 200,
) {
  publicIdSchema("review").parse(reviewId);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("invalid log cursor");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("invalid log page size");
  const page = await database.db
    .select({
      sequence: logs.sequence,
      event: logs.event,
      count: database.db
        .$count(logs, eq(logs.reviewId, reviews.id))
        .as("log_count"),
    })
    .from(reviews)
    .leftJoin(
      logs,
      and(eq(logs.reviewId, reviews.id), gt(logs.sequence, cursor)),
    )
    .where(eq(reviews.publicId, reviewId))
    .orderBy(asc(logs.sequence))
    .limit(limit);
  const total = page[0]?.count ?? 0;
  const records = page.flatMap(({ sequence, event }) =>
    sequence === null || event === null ? [] : [{ sequence, event }],
  );
  return {
    logs: records,
    count: total,
    caughtUp: (records.at(-1)?.sequence ?? cursor) >= total,
  };
}
