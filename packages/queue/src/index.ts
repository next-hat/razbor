import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, type JobWithMetadata } from "pg-boss";

import type { QueueJob } from "@razbor/contracts";
import type { Database, Transaction } from "@razbor/database";

export type ReviewQueue = PgBoss & { readonly name: string };

export type ReviewQueueJob = JobWithMetadata<QueueJob>;

export const queueDefaults = {
  retryLimit: 2,
  retryDelay: 2,
  retryBackoff: true,
  heartbeatSeconds: 30,
  expireInSeconds: 86400,
  retentionSeconds: 604800,
  deleteAfterSeconds: 604800,
};

/** Resolve the configured queue name shared by migration and runtime clients. */
export function reviewQueueName() {
  return process.env.REVIEW_QUEUE || "reviews";
}

/**
 * Start pg-boss against the application's existing pool and a queue installed
 * by the migration role; stop queue timers without owning the database pool.
 */
export async function createQueue(
  database: Database,
  name = reviewQueueName(),
): Promise<ReviewQueue> {
  const queue = Object.assign(
    new PgBoss({
      schema: "pgboss",
      migrate: false,
      schedule: false,
      supervise: true,
      reindex: false,
      persistQueueStats: false,
      db: {
        /** Execute queue queries through the pool owned by the application. */
        executeSql: (text, values) => database.pool.query(text, values),
      },
    }),
    { name },
  );
  queue.on("error", () => console.error("Review queue unavailable"));
  try {
    await queue.start();
    const configuration = await queue.getQueue(name);
    if (configuration?.policy !== "exclusive")
      throw new Error(
        "Review queue is not initialized; run database migrations",
      );
    return queue;
  } catch (error) {
    await queue.stop().catch(() => {});
    throw error;
  }
}

/**
 * Renew only the fetched claim, reusing an existing application transaction when
 * provided so ownership checks never wait for a second shared-pool connection.
 */
export async function touchReviewJob(
  queue: ReviewQueue,
  job: ReviewQueueJob,
  transaction?: Transaction,
): Promise<boolean> {
  const response = await queue.touch(queue.name, job, {
    ...(transaction ? { db: fromDrizzle(transaction, sql) } : {}),
  });
  return "affected" in response && response.affected === 1;
}

/**
 * Replace only the fetched claim with deferred work in one transaction,
 * preserving its remaining retry budget when runner capacity is unavailable.
 * A stale claim returns false without changing the current owner's job.
 */
export async function deferReviewJob(
  database: Database,
  queue: ReviewQueue,
  job: ReviewQueueJob,
  retryAt: number,
): Promise<boolean> {
  const connection = await database.pool.connect();
  const db = {
    /** Keep every queue mutation on the transaction's pinned connection. */
    executeSql: (text: string, values?: unknown[]) =>
      connection.query(text, values),
  };
  try {
    await connection.query("BEGIN");
    const cancelled = await queue.cancel(queue.name, job, { db });
    if (!("affected" in cancelled) || cancelled.affected !== 1) {
      await connection.query("ROLLBACK");
      return false;
    }
    const replacement = await queue.send(queue.name, job.data, {
      ...queueDefaults,
      retryLimit: Math.max(0, job.retryLimit - job.retryCount),
      singletonKey: job.data.reviewId,
      startAfter: new Date(retryAt),
      db,
    });
    if (!replacement) throw new Error("Deferred review could not be queued");
    await queue.deleteJob(queue.name, job.id, { db });
    await connection.query("COMMIT");
    return true;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export { dispatchPending, startDispatcher } from "@queue/src/dispatch.js";
