import {
  processInteractions,
  pendingDispatches,
  dispatched,
  getReview,
  getRepository,
  interactionLock,
  recoverDispatches,
  listDeletingRepositories,
  repositoryDeletionError,
  finishRepositoryDeletion,
  removeRepositoryWebhook,
  type Database,
} from "@razbor/database";

import {
  queueDefaults,
  type ReviewQueue,
  type ReviewQueueJob,
} from "@queue/src/index.js";

/**
 * Deliver durable outbox entries to pg-boss under the repository deletion lock,
 * checking runner eligibility before enqueueing when supplied.
 */
export async function dispatchPending(
  database: Database,
  queue: ReviewQueue,
  eligible?: (reviewId: string) => Promise<boolean>,
) {
  for (const job of await pendingDispatches(database, !!eligible)) {
    await interactionLock(
      database,
      `repository-delete:${job.repositoryId}`,
      async () => {
        const durable = await getReview(database, job.reviewId);
        const repository = await getRepository(database, job.repositoryId);
        if (
          !durable ||
          repository?.status !== "active" ||
          durable.status === "completed" ||
          durable.status === "failed"
        ) {
          await dispatched(database, job.reviewId);
          return;
        }
        // Readiness is checked before queue consumption and again atomically
        // when the trusted broker reserves an attempt.
        if (eligible && !(await eligible(job.reviewId))) return;
        const existing = await queue.findJobs(queue.name, {
          key: job.reviewId,
        });
        if (
          !existing.some(
            (entry) =>
              entry.state === "created" ||
              entry.state === "retry" ||
              entry.state === "active",
          )
        ) {
          // Exclusive singleton keys suppress only queued or active work;
          // retained terminal jobs must not prevent durable recovery.
          await queue.send(queue.name, job, {
            ...queueDefaults,
            singletonKey: job.reviewId,
          });
        }
        await dispatched(database, job.reviewId);
      },
    );
  }
}

/**
 * Remove queued work under a row lock acquired through pg-boss's partial
 * update API; return false if a broker claimed it before the update. Terminal
 * jobs cannot be claimed and can be deleted without taking that queued lock.
 */
async function removeInactiveJob(
  database: Database,
  queue: ReviewQueue,
  job: ReviewQueueJob,
): Promise<boolean> {
  if (job.state === "active") return false;
  if (job.state !== "created" && job.state !== "retry") {
    await queue.deleteJob(queue.name, job.id);
    return true;
  }
  const connection = await database.pool.connect();
  const db = {
    /** Keep the queue update and removal on the same transaction connection. */
    executeSql: (text: string, values?: unknown[]) =>
      connection.query(text, values),
  };
  try {
    await connection.query("BEGIN");
    const locked = await queue.update(queue.name, undefined, {
      id: job.id,
      startAfter: job.startAfter,
      db,
    });
    if (locked.updated !== 1) {
      await connection.query("ROLLBACK");
      return false;
    }
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

/**
 * Remove inactive queue jobs and the owned webhook before finalizing
 * repository deletion; leave active jobs and failed cleanup for a later pass.
 */
export async function processRepositoryDeletions(
  database: Database,
  queue: ReviewQueue,
) {
  for (const repository of await listDeletingRepositories(database)) {
    try {
      await interactionLock(
        database,
        `repository-delete:${repository.id}`,
        async () => {
          let running = false;
          for (const reviewId of repository.reviewIds) {
            for (const job of await queue.findJobs<ReviewQueueJob["data"]>(
              queue.name,
              { key: reviewId },
            )) {
              if (!(await removeInactiveJob(database, queue, job)))
                running = true;
            }
          }
          if (running) return;
          if (!(await removeRepositoryWebhook(database, repository.id))) return;
          await finishRepositoryDeletion(database, repository.id);
        },
      );
    } catch {
      await repositoryDeletionError(database, repository.id).catch(() => {});
    }
  }
}

/**
 * Start a nonoverlapping reconciliation loop for cleanup, publication,
 * recovery and dispatch; return an async stop function that drains the current
 * pass.
 */
export function startDispatcher(
  database: Database,
  queue: ReviewQueue,
  onError: () => void,
  eligible?: (reviewId: string) => Promise<boolean>,
) {
  let stopping = false;
  let current: Promise<void> | undefined;
  /**
   * Run one reconciliation pass unless stopping or already busy, forwarding
   * failures to the caller's handler.
   */
  const tick = () => {
    if (stopping || current) return;
    current = (async () => {
      await processRepositoryDeletions(database, queue);
      await processInteractions(database);
      await recoverDispatches(database);
      await dispatchPending(database, queue, eligible);
    })()
      .catch(onError)
      .finally(() => {
        current = undefined;
      });
  };
  const timer = setInterval(tick, 1000).unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await current;
  };
}
