import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { RequestInit as UndiciRequestInit } from "undici";
import { z } from "zod";

import {
  commitSchema,
  memoryOperationSchema,
  publicIdSchema,
  reviewProgressSchema,
  reviewAttemptMetricsSchema,
  reviewResultSchema,
  validateFindingChecks,
  type QueueJob,
  type ReviewProgress,
  type ReviewAttemptMetrics,
  type ReviewResult,
  type RunnerModelPolicy,
  type ModelProvider,
  type ReasoningEffort,
} from "@razbor/contracts";
import {
  finishAttempt,
  appendReviewLog,
  hasEligibleRunner,
  ownsAttempt,
  recordAttemptMetrics,
  renewRunnerAttempt,
  reserveEligibleRunnerAttempt,
  type Database,
  type Transaction,
} from "@razbor/database";
import { MemoryError, memoryOperation } from "@razbor/database/memory";
import { resolveRepositoryMcpServer } from "@razbor/database/mcp";
import {
  createQueue,
  deferReviewJob,
  startDispatcher,
  touchReviewJob,
  type ReviewQueue,
  type ReviewQueueJob,
} from "@razbor/queue";
import { errorDetails, logger } from "@razbor/harness/logger";
import { runnerConfigSchema } from "@razbor/runner/config";
import { ModelRelay, type RelayConfig } from "@razbor/runner/relay";

import { reviewDatabase } from "@web/lib/review.js";
import { indexPreparationDispatcher } from "@web/lib/indexer.js";

const leaseMs = 30000;

/** Encode protocol header values using the MCP SDK's printable ASCII or UTF-8 base64 format. */
function mcpHeaderValue(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code !== 9 && (code < 32 || code > 126);
    }) ||
    (value.startsWith("=?base64?") && value.endsWith("?="))
  )
    return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
  return value;
}

const bindingSchema = z
  .object({
    attemptId: publicIdSchema("attempt"),
    workspaceId: publicIdSchema("workspace"),
    id: publicIdSchema("token"),
    token: z.string().min(32).max(256),
    expiresAt: z.number(),
    headSha: commitSchema,
    indexHeadSha: commitSchema,
    indexBranch: z.string().min(1),
    project: publicIdSchema("workspace"),
  })
  .strict();

type Binding = z.infer<typeof bindingSchema>;

type Completion = {
  result?: ReviewResult;
  terminal?: boolean;
  metrics?: ReviewAttemptMetrics;
};

class TerminalReviewError extends Error {
  /** Prevents retrying a queue claim whose durable review is already terminal. */
  constructor(message: string) {
    super(message);
  }
}

type ActiveAttempt = {
  id: string;
  runnerId: string;
  sessionId: string;
  job: QueueJob;
  queueJob: ReviewQueueJob;
  capability: string;
  controller: AbortController;
  leaseUntil: number;
  deadline: number;
  delivered: boolean;
  binding?: Binding;
  agent?: {
    provider: ModelProvider;
    model: string;
    reasoningEffort?: ReasoningEffort;
  };
  agentConnection?: {
    provider: ModelProvider;
    endpoint: string;
    apiKey: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
  };
  modelToken?: string;
  revokeModel?: () => void;
  ready: boolean;
  finalizing?: Promise<void>;
  complete: (completion: Completion) => void;
  logs: Promise<void>;
  logCount: number;
  mcpSessions?: Map<string, { connection: string; ids: Set<string> }>;
};

const runnerRequestErrorBrand = Symbol.for("razbor.runner-request-error");

const runnerRequestStatuses = new Set([
  400, 401, 403, 404, 409, 413, 415, 502, 503,
]);

export class RunnerRequestError extends Error {
  readonly [runnerRequestErrorBrand] = true;
  /**
   * Creates a branded rejection that the HTTP boundary can safely map to an allowed
   * status.
   */
  constructor(
    readonly status: number,
    message = "runner operation rejected",
  ) {
    super(message);
  }
}

/**
 * Recognizes only branded broker errors with allowed HTTP statuses, including errors
 * from another module instance after a reload.
 */
export function isRunnerRequestError(
  error: unknown,
): error is RunnerRequestError {
  if (!error || typeof error !== "object") return false;
  return (
    Object.getOwnPropertyDescriptor(error, runnerRequestErrorBrand)?.value ===
      true &&
    runnerRequestStatuses.has(
      Object.getOwnPropertyDescriptor(error, "status")?.value,
    )
  );
}

/**
 * Reads an uncompressed request body up to a byte limit, cancelling its reader on
 * failure and returning an empty buffer for no body.
 */
export async function boundedRunnerBody(
  request: Request,
  limit = 65536,
  signal = request.signal,
) {
  if (request.headers.has("content-encoding"))
    throw new RunnerRequestError(400);
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  /** Interrupt a pending body read when its operation is cancelled. */
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new RunnerRequestError(413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Requires JSON content type and parses a bounded runner request body. */
export async function runnerJson(request: Request, limit = 65536) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new RunnerRequestError(415);
  return JSON.parse((await boundedRunnerBody(request, limit)).toString("utf8"));
}

/**
 * Resolves the indexer management endpoint and token, rejecting operations while either
 * setting is absent.
 */
function indexConfiguration() {
  const endpoint = process.env.RAZBOR_INDEX_ENDPOINT;
  const token = process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN;
  if (!endpoint || !token) throw new RunnerRequestError(503);
  return { endpoint, token };
}

/** Compares equal-length secret buffers with a timing-safe comparison. */
function sameSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RunnerBroker {
  private readonly owner = `broker:${randomUUID()}`;
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly completed = new Map<
    string,
    {
      runnerId: string;
      sessionId: string;
      expires: number;
    }
  >();
  private readonly processing = new Set<Promise<void>>();
  private readonly polling: Promise<void>;
  private readonly relayConfig: RelayConfig;
  private readonly relay: ModelRelay;
  private readonly stopDispatch: () => Promise<void>;
  private stopping = false;

  /**
   * Starts dispatch and bounded queue polling on an already initialized PostgreSQL
   * queue. Runners continue to use authenticated HTTP without database credentials.
   */
  constructor(
    private readonly database: Database,
    private readonly queue: ReviewQueue,
  ) {
    const defaults = runnerConfigSchema.parse({});
    this.relayConfig = {
      model: defaults.model,
      runner: { ...defaults.runner, timeout_ms: 3600000 },
    };
    this.relay = new ModelRelay(this.relayConfig);
    /**
     * Aborts all active attempts when the queue connection can no longer support
     * ownership.
     */
    const cancel = () => {
      for (const attempt of this.active.values()) attempt.controller.abort();
    };
    this.queue.on("error", () => {
      cancel();
      console.error("Runner broker queue unavailable");
    });
    this.stopDispatch = startDispatcher(
      database,
      this.queue,
      () => console.error("Runner broker dispatch unavailable; will retry"),
      async (reviewId) => {
        try {
          indexConfiguration();
        } catch {
          return false;
        }
        return hasEligibleRunner(database, reviewId);
      },
    );
    this.polling = this.poll();
  }

  /**
   * Fetches at most 64 claims at once and retries availability failures without
   * overlapping polls. Queue maintenance recovers claims after a broker crash.
   */
  private async poll() {
    while (!this.stopping) {
      try {
        const capacity = 64 - this.processing.size;
        if (capacity > 0) {
          const jobs = await this.queue.fetch<QueueJob>(this.queue.name, {
            batchSize: capacity,
            includeMetadata: true,
          });
          for (const job of jobs) {
            const processing = this.execute(job).finally(() => {
              this.processing.delete(processing);
            });
            this.processing.add(processing);
          }
        }
      } catch {
        for (const attempt of this.active.values()) attempt.controller.abort();
        console.error("Runner broker queue unavailable; will retry");
      }
      if (!this.stopping)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1000).unref();
        });
    }
  }

  /**
   * Settles only the fetched pg-boss attempt. Terminal durable reviews cancel their
   * claim, while ordinary failures use the queue's remaining retry allowance.
   */
  private async execute(job: ReviewQueueJob) {
    try {
      // A fetch already in flight can return after shutdown stops new processing.
      if (this.stopping) {
        await deferReviewJob(this.database, this.queue, job, Date.now() + 2000);
        return;
      }
      const outcome = await this.process(job);
      if (!outcome.deferred)
        await this.queue.complete(this.queue.name, job, outcome.result);
    } catch (error) {
      try {
        if (error instanceof TerminalReviewError)
          await this.queue.cancel(this.queue.name, job);
        else await this.queue.fail(this.queue.name, job);
      } catch {
        for (const attempt of this.active.values()) attempt.controller.abort();
        console.error("Runner broker queue settlement unavailable");
      }
    }
  }

  /**
   * Renews only the fetched queue claim and checks durable attempt ownership,
   * failing closed on errors or a two-second timeout. Passing retryCount prevents a
   * stale broker from touching a newer claim. Memory writes reuse their transaction.
   */
  private async owns(attempt: ActiveAttempt, transaction?: Transaction) {
    if (
      attempt.controller.signal.aborted ||
      Date.now() >= attempt.leaseUntil ||
      Date.now() >= attempt.deadline
    )
      return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const owned = await Promise.race([
        touchReviewJob(this.queue, attempt.queueJob, transaction).then(
          (touched) =>
            touched &&
            ownsAttempt(
              this.database,
              attempt.job.reviewId,
              attempt.id,
              this.owner,
              transaction,
            ),
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      return (
        owned &&
        !attempt.controller.signal.aborted &&
        Date.now() < attempt.leaseUntil &&
        Date.now() < attempt.deadline
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Rejects expired ownership and aborts the attempt before any further work is
   * accepted, optionally checking within an already-open transaction.
   */
  private async requireOwned(
    attempt: ActiveAttempt,
    transaction?: Transaction,
  ) {
    if (!(await this.owns(attempt, transaction))) {
      attempt.controller.abort();
      throw new RunnerRequestError(409, "attempt ownership expired");
    }
  }

  /**
   * Validates and serializes bounded progress logs in order, ignoring log-storage
   * failures without exposing arbitrary event fields.
   */
  private record(attempt: ActiveAttempt, event: ReviewProgress) {
    if (attempt.logCount++ >= 500) return;
    const safe = reviewProgressSchema.parse(event);
    attempt.logs = attempt.logs
      .then(() =>
        appendReviewLog(
          this.database,
          attempt.job.reviewId,
          attempt.id,
          this.owner,
          safe,
        ),
      )
      .then(() => {})
      .catch(() => {});
  }

  /**
   * Requests a revision-bound source workspace and stores its capability only after
   * validating the binding and current ownership.
   */
  private async prepare(attempt: ActiveAttempt) {
    const { endpoint, token } = indexConfiguration();
    const start = performance.now();
    const timeoutMs = Math.max(1, attempt.deadline - Date.now());
    const signal = AbortSignal.any([
      attempt.controller.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const response = await fetch(new URL("/reviews", endpoint), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      dispatcher: indexPreparationDispatcher,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repositoryId: attempt.job.repositoryId,
        reviewId: attempt.job.reviewId,
        attemptId: attempt.id,
        baseSha: attempt.job.baseSha,
        headSha: attempt.job.headSha,
        ttlMs: Math.max(1000, Math.min(3600000, timeoutMs)),
      }),
    } as RequestInit & Pick<UndiciRequestInit, "dispatcher">);
    if (!response.ok) {
      logger.warn(
        {
          reviewId: attempt.job.reviewId,
          attemptId: attempt.id,
          runnerId: attempt.runnerId,
          operation: "prepare-source",
          httpStatus: response.status,
          timeoutMs,
          durationMs: Math.round(performance.now() - start),
          cancelled: attempt.controller.signal.aborted,
        },
        "runner source preparation rejected",
      );
      await response.body?.cancel().catch(() => {});
      throw new Error("source preparation unavailable");
    }
    const body = await boundedRunnerBody(
      new Request("http://internal/", {
        method: "POST",
        body: response.body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      16384,
      signal,
    );
    const binding = bindingSchema.parse(JSON.parse(body.toString("utf8")));
    if (
      binding.attemptId !== attempt.id ||
      binding.headSha !== attempt.job.headSha ||
      binding.expiresAt <= Date.now()
    )
      throw new Error("source binding does not match the assigned attempt");
    await this.requireOwned(attempt);
    attempt.binding = binding;
  }

  /**
   * Reserves a durable runner attempt, supervises its lease and deadline, and releases
   * its relay and source workspace when processing ends.
   */
  private async process(job: ReviewQueueJob) {
    if (this.stopping) throw new Error("broker stopping");
    if (job.singletonKey !== job.data.reviewId)
      throw new TerminalReviewError("queue review ID mismatch");
    const reservation = await reserveEligibleRunnerAttempt(
      this.database,
      job.data.reviewId,
      this.owner,
      leaseMs,
    );
    if (reservation.kind === "completed")
      return { deferred: false as const, result: reservation.result };
    if (reservation.kind === "failed")
      throw new TerminalReviewError("review has terminal durable state");
    if (reservation.kind === "busy" || reservation.kind === "unavailable") {
      await deferReviewJob(
        this.database,
        this.queue,
        job,
        reservation.kind === "busy" ? reservation.retryAt : Date.now() + 2000,
      );
      return { deferred: true as const };
    }
    let complete!: (completion: Completion) => void;
    const completion = new Promise<Completion>((resolve) => {
      complete = resolve;
    });
    const attempt: ActiveAttempt = {
      id: reservation.attemptId,
      runnerId: reservation.runnerId,
      sessionId: reservation.sessionId,
      job: reservation.job,
      queueJob: job,
      capability: randomBytes(32).toString("hex"),
      controller: new AbortController(),
      leaseUntil: reservation.leaseUntil,
      deadline: reservation.deadline,
      delivered: false,
      ready: false,
      complete,
      logs: Promise.resolve(),
      logCount: 0,
    };
    this.active.set(attempt.id, attempt);
    const start = performance.now();
    let checking = false;
    let lastRenewal = Date.now();
    const deadlineTimer = setTimeout(
      () => attempt.controller.abort(),
      Math.max(1, attempt.deadline - Date.now()),
    ).unref();
    const watchdog = setInterval(() => {
      if (attempt.controller.signal.aborted) return;
      if (Date.now() >= attempt.leaseUntil || Date.now() >= attempt.deadline) {
        attempt.controller.abort();
        return;
      }
      if (checking) return;
      checking = true;
      void (async () => {
        if (Date.now() >= attempt.deadline || !(await this.owns(attempt))) {
          attempt.controller.abort();
          return;
        }
        // Preparation has not reached the host yet. Its session heartbeat is
        // the liveness proof until the runner receives and renews this attempt.
        if (!attempt.delivered && Date.now() - lastRenewal >= 10000) {
          const renewed = await renewRunnerAttempt(
            this.database,
            attempt.runnerId,
            attempt.sessionId,
            attempt.job.reviewId,
            attempt.id,
            this.owner,
            leaseMs,
          );
          if (!renewed) attempt.controller.abort();
          else {
            attempt.leaseUntil = renewed;
            lastRenewal = Date.now();
          }
        }
      })()
        .catch(() => attempt.controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 1000).unref();
    const aborted = new Promise<never>((_, reject) => {
      attempt.controller.signal.addEventListener(
        "abort",
        () => reject(new Error("attempt interrupted")),
        { once: true },
      );
    });
    // The rejection is also consumed below after preparation; avoid an unhandled
    // promise while an aborted upstream preparation is still unwinding.
    void aborted.catch(() => {});
    try {
      // Shutdown may have started while the durable reservation was in flight.
      // Install the abort listener before cancelling this newly registered attempt.
      if (this.stopping) attempt.controller.abort();
      attempt.controller.signal.throwIfAborted();
      this.record(attempt, {
        time: new Date().toISOString(),
        source: "app",
        stage: "prepare",
        level: "info",
        message: "Preparing source for the assigned runner",
      });
      await this.prepare(attempt);
      if (reservation.agent) {
        attempt.agent = {
          provider: reservation.agent.provider,
          model: reservation.agent.model,
          reasoningEffort: reservation.agent.reasoningEffort,
        };
        attempt.agentConnection = reservation.agent;
      }
      attempt.ready = true;
      const outcome = await Promise.race([completion, aborted]);
      if (outcome.result)
        return { deferred: false as const, result: outcome.result };
      if (outcome.terminal)
        throw new TerminalReviewError("runner reported terminal failure");
      throw new Error("runner attempt interrupted");
    } catch (error) {
      logger.warn(
        {
          reviewId: attempt.job.reviewId,
          attemptId: attempt.id,
          runnerId: attempt.runnerId,
          phase: attempt.ready ? "execution" : "prepare-source",
          durationMs: Math.round(performance.now() - start),
          cancelled: attempt.controller.signal.aborted,
          error: errorDetails(error, [
            process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN ?? "",
            attempt.capability,
            attempt.binding?.token ?? "",
            attempt.modelToken ?? "",
            reservation.agent?.apiKey ?? "",
            this.relayConfig.apiKey ?? "",
          ]),
        },
        "runner attempt processing failed",
      );
      if (!attempt.finalizing) {
        const terminal =
          Date.now() >= attempt.deadline || job.retryCount >= job.retryLimit;
        await attempt.logs;
        await finishAttempt(
          this.database,
          attempt.job.reviewId,
          attempt.id,
          this.owner,
          undefined,
          terminal,
        ).catch(() => {});
        if (terminal)
          throw new TerminalReviewError(
            "runner attempt deadline or retry limit reached",
          );
      }
      throw error;
    } finally {
      clearInterval(watchdog);
      clearTimeout(deadlineTimer);
      attempt.controller.abort();
      attempt.revokeModel?.();
      this.active.delete(attempt.id);
      await attempt.logs;
      const { endpoint, token: managementToken } = indexConfiguration();
      await fetch(new URL(`/reviews/${attempt.id}`, endpoint), {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${managementToken}` },
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
  }

  /**
   * Delivers an eligible prepared attempt for the runner session, issuing its model
   * relay access once under the supplied policy.
   */
  async claim(
    runnerId: string,
    sessionId: string,
    activeAttemptIds: string[] = [],
    modelPolicy: RunnerModelPolicy,
  ) {
    for (const attempt of this.active.values()) {
      if (
        attempt.runnerId !== runnerId ||
        attempt.sessionId !== sessionId ||
        activeAttemptIds.includes(attempt.id) ||
        !attempt.ready ||
        attempt.finalizing
      )
        continue;
      await this.requireOwned(attempt);
      if (attempt.agentConnection && !attempt.modelToken) {
        const access = this.relay.issue(
          attempt.controller.signal,
          undefined,
          (message, level = "error") =>
            this.record(attempt, {
              time: new Date().toISOString(),
              source: "app",
              stage: "model",
              level,
              message,
            }),
          {
            ...this.relayConfig,
            endpoint: attempt.agentConnection.endpoint,
            apiKey: attempt.agentConnection.apiKey,
            model: {
              ...this.relayConfig.model,
              ...modelPolicy,
              provider: attempt.agentConnection.provider,
              model: attempt.agentConnection.model,
              // Saved review profiles pin effort; legacy snapshots retain runner policy.
              reasoning_effort:
                attempt.agentConnection.reasoningEffort ??
                modelPolicy.reasoning_effort,
            },
          },
        );
        attempt.modelToken = access.token;
        attempt.revokeModel = access.revoke;
        attempt.agentConnection = undefined;
      }
      attempt.delivered = true;
      return {
        assignment: {
          attemptId: attempt.id,
          job: attempt.job,
          capabilityToken: attempt.capability,
          memory: { queryMs: 15000 },
          leaseUntil: new Date(attempt.leaseUntil).toISOString(),
          deadline: new Date(attempt.deadline).toISOString(),
          ...(attempt.agent ? { agent: attempt.agent } : {}),
          ...(attempt.binding
            ? {
                index: {
                  project: attempt.binding.project,
                  indexHeadSha: attempt.binding.indexHeadSha,
                  indexBranch: attempt.binding.indexBranch,
                  queryMs: 15000,
                },
              }
            : {}),
        },
      };
    }
    return { assignment: null };
  }

  /**
   * Finds an active attempt bound to exactly this runner and session, otherwise
   * rejecting stale or foreign ownership.
   */
  private assigned(id: string, runnerId: string, sessionId: string) {
    const attempt = this.active.get(id);
    if (
      !attempt ||
      attempt.runnerId !== runnerId ||
      attempt.sessionId !== sessionId
    )
      throw new RunnerRequestError(409, "attempt ownership expired");
    return attempt;
  }

  /**
   * Renews the durable attempt lease only while broker ownership remains valid,
   * aborting on renewal failure.
   */
  async renew(id: string, runnerId: string, sessionId: string) {
    const attempt = this.assigned(id, runnerId, sessionId);
    await this.requireOwned(attempt);
    const renewed = await renewRunnerAttempt(
      this.database,
      runnerId,
      sessionId,
      attempt.job.reviewId,
      id,
      this.owner,
      leaseMs,
    );
    if (!renewed) {
      attempt.controller.abort();
      throw new RunnerRequestError(409);
    }
    attempt.leaseUntil = renewed;
    return {
      leaseUntil: new Date(renewed).toISOString(),
      deadline: new Date(attempt.deadline).toISOString(),
    };
  }

  /**
   * Accepts validated progress only from the attempt owner, durably records cumulative
   * telemetry, then appends through the bounded log pipeline. Log storage failures do
   * not discard metrics, and metric persistence is not subject to the log cap.
   */
  async progress(
    id: string,
    runnerId: string,
    sessionId: string,
    events: ReviewProgress[],
  ) {
    const attempt = this.assigned(id, runnerId, sessionId);
    await this.requireOwned(attempt);
    for (const event of events) {
      const safe = reviewProgressSchema.parse(event);
      const accepted = await recordAttemptMetrics(
        this.database,
        attempt.job.reviewId,
        attempt.id,
        this.owner,
        safe,
      );
      if (!accepted) {
        attempt.controller.abort();
        throw new RunnerRequestError(409, "attempt ownership expired");
      }
      this.record(attempt, safe);
    }
    return { accepted: true };
  }

  /**
   * Finalizes a validated outcome once, enforcing finding checks and retry limits while
   * tolerating duplicate delivery from the same session. A final cumulative snapshot
   * repairs missing progress delivery before the outcome is saved.
   */
  async result(
    id: string,
    runnerId: string,
    sessionId: string,
    outcome: Completion,
  ) {
    for (const [key, value] of this.completed)
      if (value.expires <= Date.now()) this.completed.delete(key);
    const previous = this.completed.get(id);
    if (previous?.runnerId === runnerId && previous.sessionId === sessionId)
      return { accepted: true };
    const attempt = this.assigned(id, runnerId, sessionId);
    if (!attempt.finalizing) {
      attempt.finalizing = (async () => {
        await this.requireOwned(attempt);
        const result =
          outcome.result === undefined
            ? undefined
            : reviewResultSchema.parse(outcome.result);
        if (result) {
          try {
            validateFindingChecks(
              result,
              attempt.job.previousFindings,
              !!attempt.job.conversation,
            );
          } catch {
            throw new RunnerRequestError(400, "invalid review result");
          }
        }
        const terminal =
          !!outcome.terminal ||
          attempt.queueJob.retryCount >= attempt.queueJob.retryLimit;
        if (outcome.metrics !== undefined) {
          const accepted = await recordAttemptMetrics(
            this.database,
            attempt.job.reviewId,
            id,
            this.owner,
            reviewAttemptMetricsSchema.parse(outcome.metrics),
            true,
          );
          if (!accepted)
            throw new RunnerRequestError(409, "attempt ownership expired");
        }
        // Flush accepted progress before terminal status becomes visible to SSE.
        await attempt.logs;
        await finishAttempt(
          this.database,
          attempt.job.reviewId,
          id,
          this.owner,
          result,
          terminal,
        );
        if (this.completed.size >= 500)
          this.completed.delete(this.completed.keys().next().value!);
        this.completed.set(id, {
          runnerId,
          sessionId,
          expires: Date.now() + 60000,
        });
        attempt.complete({ result, terminal });
      })().catch((error) => {
        attempt.finalizing = undefined;
        throw error;
      });
    }
    await attempt.finalizing;
    return { accepted: true };
  }

  /**
   * Validates the attempt capability, readiness, and current ownership before allowing
   * source, model, index, or memory access.
   */
  async capability(id: string, token: string) {
    const attempt = this.active.get(id);
    if (
      !attempt ||
      !attempt.ready ||
      attempt.finalizing ||
      !sameSecret(attempt.capability, token)
    )
      throw new RunnerRequestError(401);
    await this.requireOwned(attempt);
    return attempt;
  }

  /**
   * Streams the assigned source pack with cancellation, object-format validation, and a
   * 512 MiB transfer ceiling.
   */
  async source(id: string, token: string, request: Request) {
    const attempt = await this.capability(id, token);
    const config = indexConfiguration();
    const upstream = await fetch(
      new URL(`/reviews/${id}/source`, config.endpoint),
      {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([
          request.signal,
          attempt.controller.signal,
          AbortSignal.timeout(30000),
        ]),
        headers: { authorization: `Bearer ${attempt.binding!.token}` },
      },
    );
    const format = upstream.headers.get("x-razbor-object-format");
    if (
      !upstream.ok ||
      !upstream.body ||
      !["sha1", "sha256"].includes(format ?? "")
    ) {
      await upstream.body?.cancel();
      throw new RunnerRequestError(502);
    }
    let bytes = 0;
    const stream = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        /**
         * Forwards source chunks until the cumulative transfer limit is exceeded, then
         * fails the stream.
         */
        transform(chunk, controller) {
          bytes += chunk.length;
          if (bytes > 512 * 1024 * 1024)
            throw new Error("source transfer limit exceeded");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(stream, {
      headers: {
        "content-type": "application/x-git-packed-objects",
        "cache-control": "no-store",
        "x-razbor-object-format": format!,
      },
    });
  }

  /**
   * Routes an owned attempt through its scoped model relay without forwarding the
   * upstream credential to the runner.
   */
  async model(
    id: string,
    token: string,
    request: Request,
    route: "responses" | "messages" = "responses",
  ) {
    const attempt = await this.capability(id, token);
    if (!attempt.modelToken) throw new RunnerRequestError(403);
    const body = await boundedRunnerBody(request, 10000000);
    return this.relay.handleRequest(
      new Request(`http://internal/v1/${route}`, {
        method: "POST",
        body,
        headers: {
          authorization: `Bearer ${attempt.modelToken}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.any([request.signal, attempt.controller.signal]),
      }),
    );
  }

  /**
   * Executes a bounded memory operation in the active review's repository scope.
   * The attempt supplies provenance and authorization; model input cannot choose a
   * repository or impersonate a human editor.
   */
  async memory(id: string, token: string, request: Request) {
    const attempt = await this.capability(id, token);
    const input = memoryOperationSchema.parse(
      await runnerJson(request, 1048576),
    );
    request.signal.throwIfAborted();
    await this.requireOwned(attempt);
    /** Recheck cancellation and ownership after database locks have been acquired. */
    const beforeWrite = async (transaction: Transaction) => {
      request.signal.throwIfAborted();
      attempt.controller.signal.throwIfAborted();
      await this.requireOwned(attempt, transaction);
      request.signal.throwIfAborted();
      attempt.controller.signal.throwIfAborted();
    };
    try {
      const result = await memoryOperation(
        this.database,
        attempt.job.repositoryId,
        input,
        {
          actor: "bot",
          reviewId: attempt.job.reviewId,
          headSha: attempt.job.headSha,
        },
        { beforeWrite },
      );
      await this.requireOwned(attempt);
      return Response.json(result, {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      await this.requireOwned(attempt);
      return Response.json(
        {
          error: error.message,
          ...(error.current ? { current: error.current } : {}),
        },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
  }

  /**
   * Proxies an approved HTTP server through live repository grants. Remote sessions
   * stay bound to this attempt and connection; responses remain bounded and cancellable.
   */
  async externalMcp(
    id: string,
    token: string,
    serverId: string,
    request: Request,
  ) {
    const attempt = await this.capability(id, token);
    if (!attempt.job.mcpServers?.some((server) => server.id === serverId))
      throw new RunnerRequestError(403);
    const signal = AbortSignal.any([
      request.signal,
      attempt.controller.signal,
      AbortSignal.timeout(15000),
    ]);
    const connection = await resolveRepositoryMcpServer(
      this.database,
      attempt.job.repositoryId,
      serverId,
    );
    if (!connection) throw new RunnerRequestError(403);
    // A changed endpoint or credential must not receive a previous server's session ID.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([connection.endpoint, connection.token]))
      .digest("hex");
    const body =
      request.method === "POST"
        ? await boundedRunnerBody(request, 65536, signal)
        : undefined;
    let method: string | undefined;
    let toolName: string | undefined;
    if (body) {
      if (
        request.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json"
      )
        throw new RunnerRequestError(415);
      const message = JSON.parse(body.toString("utf8"));
      if (
        !message ||
        Array.isArray(message) ||
        message.jsonrpc !== "2.0" ||
        ![
          "initialize",
          "notifications/initialized",
          "notifications/cancelled",
          "ping",
          "tools/list",
          "tools/call",
        ].includes(message.method)
      )
        throw new RunnerRequestError(403);
      method = message.method;
      if (method === "tools/call") {
        if (
          typeof message.params?.name !== "string" ||
          message.params.name.length > 256
        )
          throw new RunnerRequestError(400);
        toolName = message.params.name;
      }
    }
    attempt.mcpSessions ??= new Map();
    let sessions = attempt.mcpSessions.get(serverId);
    const sessionId = request.headers.get("mcp-session-id");
    if (sessions && sessions.connection !== fingerprint) {
      if (method !== "initialize" || sessionId)
        throw new RunnerRequestError(403);
      sessions = undefined;
    }
    if (sessionId && !sessions?.ids.has(sessionId))
      throw new RunnerRequestError(403);
    if (!sessions) {
      sessions = { connection: fingerprint, ids: new Set() };
      attempt.mcpSessions.set(serverId, sessions);
    }
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(connection.token
        ? { authorization: `Bearer ${connection.token}` }
        : {}),
    });
    for (const name of [
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ])
      if (request.headers.has(name))
        headers.set(name, request.headers.get(name)!);
    if (method) headers.set("mcp-method", method);
    if (toolName) headers.set("mcp-name", mcpHeaderValue(toolName));
    /** Recheck live authorization before dispatch and before returning remote data. */
    const ensureAccess = async () => {
      signal.throwIfAborted();
      await this.requireOwned(attempt);
      const current = await resolveRepositoryMcpServer(
        this.database,
        attempt.job.repositoryId,
        serverId,
      );
      if (
        !current ||
        createHash("sha256")
          .update(JSON.stringify([current.endpoint, current.token]))
          .digest("hex") !== fingerprint
      )
        throw new RunnerRequestError(403);
      signal.throwIfAborted();
    };
    await ensureAccess();
    const upstream = await fetch(connection.endpoint, {
      method: request.method,
      redirect: "error",
      cache: "no-store",
      signal,
      headers,
      body,
    });
    try {
      await ensureAccess();
      if (!upstream.ok) {
        await upstream.body?.cancel();
        if (upstream.status === 404 && sessionId)
          sessions.ids.delete(sessionId);
        return Response.json(
          { error: "MCP request rejected" },
          {
            status: [400, 401, 403, 404, 405, 409, 429].includes(
              upstream.status,
            )
              ? upstream.status
              : 502,
            headers: { "cache-control": "no-store" },
          },
        );
      }
      const responseHeaders = new Headers({ "cache-control": "no-store" });
      for (const name of [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
      ])
        if (upstream.headers.has(name))
          responseHeaders.set(name, upstream.headers.get(name)!);
      const issuedSession = upstream.headers.get("mcp-session-id");
      if (issuedSession && method === "initialize") {
        if (!/^[!-~]{1,256}$/.test(issuedSession) || sessions.ids.size >= 4)
          throw new RunnerRequestError(502);
        sessions.ids.add(issuedSession);
      }
      if (request.method === "DELETE" && sessionId)
        sessions.ids.delete(sessionId);
      // Accepted MCP notifications return 202 without protocol content or a content type.
      if (!upstream.body || [202, 204, 205, 304].includes(upstream.status)) {
        await upstream.body?.cancel();
        return new Response(null, {
          status: upstream.status,
          headers: responseHeaders,
        });
      }
      const contentType = upstream.headers
        .get("content-type")
        ?.split(";")[0]
        .trim();
      if (
        !["application/json", "text/event-stream"].includes(contentType ?? "")
      )
        throw new RunnerRequestError(502);
      const reader = upstream.body.getReader();
      let size = 0;
      let checkedAt = Date.now();
      const stream = new ReadableStream<Uint8Array>({
        /** Forward bounded protocol chunks and periodically recheck a long response's grant. */
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (Date.now() - checkedAt >= 1000) {
              await ensureAccess();
              checkedAt = Date.now();
            }
            signal.throwIfAborted();
            if (chunk.done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            size += chunk.value.byteLength;
            if (size > 1048576) throw new Error("MCP response too large");
            controller.enqueue(chunk.value);
          } catch {
            await reader.cancel().catch(() => {});
            controller.error(new Error("MCP transport failed"));
          }
        },
        /** Release the upstream stream when the runner cancels or disconnects. */
        async cancel() {
          await reader.cancel();
        },
      });
      return new Response(stream, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (error) {
      await upstream.body?.cancel().catch(() => {});
      throw error;
    }
  }

  /**
   * Proxies bounded index requests using the attempt binding, rechecking ownership
   * before returning allowed response headers and data.
   */
  async mcp(id: string, token: string, request: Request) {
    const attempt = await this.capability(id, token);
    if (!attempt.binding) throw new RunnerRequestError(403);
    const config = indexConfiguration();
    const headers = new Headers({
      authorization: `Bearer ${attempt.binding.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    for (const name of ["mcp-session-id", "mcp-protocol-version"])
      if (request.headers.has(name))
        headers.set(name, request.headers.get(name)!);
    const signal = AbortSignal.any([
      request.signal,
      attempt.controller.signal,
      AbortSignal.timeout(15000),
    ]);
    const upstream = await fetch(new URL("/mcp", config.endpoint), {
      method: request.method,
      redirect: "error",
      cache: "no-store",
      signal,
      headers,
      body:
        request.method === "POST"
          ? await boundedRunnerBody(request)
          : undefined,
    });
    const body = upstream.body
      ? await boundedRunnerBody(
          new Request("http://internal/", {
            method: "POST",
            body: upstream.body,
            duplex: "half",
          } as RequestInit & { duplex: "half" }),
          1048576,
        )
      : null;
    signal.throwIfAborted();
    await this.requireOwned(attempt);
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    for (const name of [
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
    ])
      if (upstream.headers.has(name))
        responseHeaders.set(name, upstream.headers.get(name)!);
    return new Response(
      [204, 205, 304].includes(upstream.status) ? null : body,
      { status: upstream.status, headers: responseHeaders },
    );
  }

  /**
   * Idempotently stops dispatch and polling, aborts and drains active attempts, then
   * stops queue maintenance and the model relay without closing the shared database.
   */
  async close() {
    if (this.stopping) return;
    this.stopping = true;
    for (const attempt of this.active.values()) attempt.controller.abort();
    await this.stopDispatch();
    await this.polling;
    await Promise.allSettled(this.processing);
    await this.queue.stop({ graceful: false });
    await this.relay.close();
  }
}

const state = globalThis as typeof globalThis & {
  razborRunnerBroker?: Promise<RunnerBroker>;
  razborRunnerBrokerShutdown?: boolean;
};

/**
 * Reuses a process-global broker, permits retry after initialization failure, and
 * registers shutdown handlers once.
 */
export function runnerBroker() {
  state.razborRunnerBroker ??= reviewDatabase()
    .then(async (database) => {
      const queue = await createQueue(database);
      return new RunnerBroker(database, queue);
    })
    .catch((error: unknown) => {
      state.razborRunnerBroker = undefined;
      throw error;
    });
  if (!state.razborRunnerBrokerShutdown) {
    state.razborRunnerBrokerShutdown = true;
    /**
     * Requests broker cleanup on a process signal without surfacing initialization or
     * shutdown failures.
     */
    const close = () => {
      void state.razborRunnerBroker
        ?.then((broker) => broker.close())
        .catch(() => {});
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  }
  return state.razborRunnerBroker;
}
