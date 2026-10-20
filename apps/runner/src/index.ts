import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import Docker from "dockerode";
import { z, ZodError } from "zod";

import {
  publicIdSchema,
  modelProviderSchema,
  reasoningEffortSchema,
  queueJobSchema,
  type ReviewAttemptMetrics,
  type ReviewProgress,
  type ReviewResult,
} from "@razbor/contracts";
import { logger } from "@razbor/harness/logger";

import { loadConfig, resolveReference } from "@runner/src/config.js";
import { validateStorage } from "@runner/src/workspace.js";
import { preflight, reconcile } from "@runner/src/docker.js";
import { ModelRelay } from "@runner/src/relay.js";
import { execute } from "@runner/src/executor.js";
import { PermanentError } from "@runner/src/errors.js";
import { AttemptProgress } from "@runner/src/progress.js";

const identitySchema = z
  .object({
    runnerId: publicIdSchema("runner"),
    credential: z.string().min(32).max(256),
    url: z.string().url(),
  })
  .strict();

const assignmentSchema = z
  .object({
    attemptId: publicIdSchema("attempt"),
    job: queueJobSchema,
    leaseUntil: z.string().datetime(),
    deadline: z.string().datetime(),
    capabilityToken: z.string().min(32).max(256),
    agent: z
      .object({
        provider: modelProviderSchema.default("openai"),
        model: z.string().min(1),
        reasoningEffort: reasoningEffortSchema.optional(),
      })
      .optional(),
    index: z
      .object({
        project: z.string(),
        indexHeadSha: z.string(),
        indexBranch: z.string(),
        queryMs: z.number().int().positive(),
      })
      .optional(),
    memory: z
      .object({ queryMs: z.number().int().min(100).max(60000) })
      .strict()
      .optional(),
  })
  .strict();

type AttemptCompletion =
  | { result: ReviewResult; metrics?: ReviewAttemptMetrics }
  | { failed: true; terminal: boolean; metrics?: ReviewAttemptMetrics };

class ControlError extends Error {
  /** Preserve the control-plane HTTP status without retaining an untrusted response body. */
  constructor(readonly status: number) {
    super(`control operation failed (${status})`);
  }
}

/**
 * Parse supported runner flags and value options, rejecting unknown options and missing
 * values.
 */
function argumentsForRunner() {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--allow-http", "--check-config", "--help"].includes(key))
      flags.add(key);
    else if (
      [
        "--url",
        "--config",
        "--enrollment-token",
        "--enrollment-token-file",
      ].includes(key) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      values[key] = args[++i];
    else
      throw new PermanentError(
        "Unknown or incomplete runner option; use --help",
      );
  }
  return { values, flags };
}

/**
 * Require a credential-free control-plane origin over HTTPS unless HTTP is explicitly
 * allowed for development.
 */
function controlUrl(value: string, allowHttp: boolean) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new PermanentError(
      "Runner URL must be an HTTPS origin; --allow-http or control.allow_http is only for trusted development networks",
    );
  return url.origin;
}

/**
 * Run the enrolled worker lifecycle: lock and restore its identity, open a session,
 * reconcile local work, renew leases, and drain attempts during bounded shutdown.
 */
async function main() {
  const { values, flags } = argumentsForRunner();
  if (flags.has("--help")) {
    console.log(
      "Usage: runner [--url HTTPS_ORIGIN --enrollment-token TOKEN | --enrollment-token-file PATH] [--config PATH] [--allow-http] [--check-config]\nTOML may include [control] url, allow_http and enrollment_token; CLI options take precedence.",
    );
    return;
  }
  if (values["--enrollment-token"] && values["--enrollment-token-file"])
    throw new PermanentError("Choose one enrollment token input");
  const c = await loadConfig(values["--config"]);
  const allowHttp = flags.has("--allow-http") || !!c.control?.allow_http;
  const configuredUrl = values["--url"] ?? c.control?.url;
  if (configuredUrl) controlUrl(configuredUrl, allowHttp);
  const tokenReference = values["--enrollment-token-file"]
    ? { file: values["--enrollment-token-file"] }
    : (values["--enrollment-token"] ??
      (process.env.RAZBOR_RUNNER_ENROLLMENT_TOKEN || undefined) ??
      c.control?.enrollment_token);
  await validateStorage(c);
  if (flags.has("--check-config")) {
    console.log(
      "Runner configuration and local runtime valid (control plane and Docker not contacted).",
    );
    return;
  }
  const stateRoot = path.join(c.storage.root, "runner-state");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(stateRoot)).isSymbolicLink())
    throw new PermanentError("Runner state must not be a symlink");
  await chmod(stateRoot, 0o700);
  const guard = spawn(
    "flock",
    [
      "--nonblock",
      path.join(stateRoot, "identity.lock"),
      process.execPath,
      "-e",
      String.raw`process.stdout.write("ready\n"); process.stdin.resume();`,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    guard.once("error", reject);
    guard.once("exit", () =>
      reject(
        new PermanentError(
          "Runner identity is already active or flock is unavailable",
        ),
      ),
    );
    guard.stdout.once("data", () => resolve());
  });
  const stop = new AbortController();
  const active = new Map<
    string,
    { cancel: AbortController; done: Promise<void> }
  >();
  let stopping = false;
  /**
   * Stop session polling once, allowing active attempts to enter the configured shutdown
   * drain.
   */
  const shutdown = () => {
    if (!stopping) {
      stopping = true;
      stop.abort();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  guard.once("exit", shutdown);
  let relay: ModelRelay | undefined;
  const file = path.join(stateRoot, "identity.json");
  try {
    let identity: z.infer<typeof identitySchema> | undefined;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.mode & 0o077)
        throw new PermanentError(
          "Runner credential file must be a regular file with mode 0600",
        );
      identity = identitySchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const url = controlUrl(configuredUrl ?? identity?.url ?? "", allowHttp);
    if (identity && identity.url !== url)
      throw new PermanentError(
        "Saved runner identity belongs to another control plane",
      );
    const docker = new Docker({ socketPath: c.docker.socket, timeout: 10000 });
    const relayHost = await preflight(c, docker);
    const sessionId = randomUUID();
    const session = {
      sessionId,
      protocolVersion: 1,
      runtimeVersion: "0.1.0",
      capacity: c.runner.concurrency,
      runtimeReady: true,
      timeoutMs: c.runner.timeout_ms,
      fallbackModel: !!(c.endpoint && c.apiKey && c.model.model),
    };
    /**
     * Convert an already server-adjusted expiry into a monotonic deadline that later
     * wall-clock changes cannot extend.
     */
    const monotonicExpiry = (value: string) =>
      performance.now() + Date.parse(value) - Date.now();
    /**
     * Send a bounded authenticated control request and translate server expiries
     * conservatively using HTTP Date and the full request duration.
     */
    const request = async (
      route: string,
      body: unknown,
      signal: AbortSignal = stop.signal,
    ) => {
      const started = performance.now();
      const response = await fetch(`${url}/api/runner${route}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          "content-type": "application/json",
          ...(identity
            ? {
                authorization: `Bearer ${identity.credential}`,
                "x-razbor-session": sessionId,
              }
            : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ControlError(response.status);
      }
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      // Claims include immutable skill text; JSON escaping can expand the bounded bundle.
      const responseLimit = route === "/claim" ? 8 * 1024 * 1024 : 2_000_000;
      if (response.body)
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > responseLimit)
            throw new Error("control response too large");
          chunks.push(chunk);
        }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // HTTP Date is server time rounded to a second. Subtract rounding and the
      // full request duration so a skewed/adjusted host clock cannot extend a lease.
      const serverNow = Date.parse(response.headers.get("date") ?? "");
      /**
       * Adjust session and attempt expiry fields for server clock offset, rounding, and
       * transport delay; reject missing server time when an expiry is present.
       */
      const translate = (object: Record<string, unknown>) => {
        for (const field of ["sessionExpiresAt", "leaseUntil", "deadline"]) {
          if (typeof object[field] !== "string") continue;
          if (!Number.isFinite(serverNow))
            throw new Error("control response lacks server time");
          object[field] = new Date(
            Date.now() +
              Date.parse(object[field]) -
              serverNow -
              1000 -
              (performance.now() - started),
          ).toISOString();
        }
      };
      translate(data);
      if (data.assignment) translate(data.assignment);
      return data;
    };
    /**
     * Retry only transient enrollment failures within a two-minute window, preserving the
     * same token and session identity.
     */
    const enrollmentRequest = async (token: string) => {
      const signal = AbortSignal.any([
        stop.signal,
        AbortSignal.timeout(120000),
      ]);
      for (;;) {
        try {
          return await request("/enroll", { ...session, token }, signal);
        } catch (error) {
          const transient =
            error instanceof ControlError
              ? [502, 503, 504].includes(error.status)
              : error instanceof TypeError ||
                (error instanceof Error && error.name === "TimeoutError");
          if (!transient || signal.aborted) throw error;
          logger.warn("Runner enrollment waiting for the control plane");
          await delay(5000, undefined, { signal });
        }
      }
    };
    let sessionUntil = 0;
    /**
     * Consume an enrollment token and atomically persist the stable credential with private
     * permissions and fsync before adopting the new session lease.
     */
    const enroll = async () => {
      if (!tokenReference)
        throw new PermanentError(
          "Supply an enrollment token from the UI or TOML provisioning on first start",
        );
      const token = await resolveReference(tokenReference);
      const enrolled = await enrollmentRequest(token);
      if (identity && identity.runnerId !== enrolled.runnerId)
        throw new PermanentError(
          "Enrollment belongs to a different saved runner identity",
        );
      identity = identitySchema.parse({
        runnerId: enrolled.runnerId,
        credential: enrolled.credential,
        url,
      });
      const temporary = `${file}.${randomUUID()}`;
      const saved = await open(temporary, "wx", 0o600);
      try {
        await saved.writeFile(JSON.stringify(identity));
        await saved.sync();
      } finally {
        await saved.close();
      }
      try {
        await rename(temporary, file);
        const directory = await open(stateRoot, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
      sessionUntil = monotonicExpiry(enrolled.sessionExpiresAt);
    };
    if (!identity) {
      await enroll();
    } else {
      // A restarted process waits for the old session's bounded lease; it never replaces a live identity.
      while (!stop.signal.aborted) {
        try {
          const opened = await request("/session", session);
          sessionUntil = monotonicExpiry(opened.sessionExpiresAt);
          break;
        } catch (error) {
          if (
            error instanceof ControlError &&
            [401, 403].includes(error.status)
          ) {
            if (!tokenReference) throw error;
            await enroll();
            break;
          }
          logger.warn(
            "Runner session unavailable; waiting for its previous lease to expire",
          );
          await delay(5000, undefined, { signal: stop.signal });
        }
      }
    }
    if (!Number.isFinite(sessionUntil))
      throw new Error("invalid session lease");
    if (!identity) throw new Error("runner enrollment unavailable");
    c.runner.name = identity.runnerId;
    await validateStorage(c);
    await reconcile(c, docker);
    relay = new ModelRelay(c);
    await relay.listen();
    let lastHeartbeat = 0;
    /**
     * Execute an assignment under renewable local lease and deadline guards, serialize
     * progress delivery, and submit a result only while ownership remains valid.
     */
    const run = async (
      assignment: z.infer<typeof assignmentSchema>,
      cancel: AbortController,
    ) => {
      let leaseUntil = monotonicExpiry(assignment.leaseUntil);
      const deadline = Math.min(
        monotonicExpiry(assignment.deadline),
        performance.now() + c.runner.timeout_ms,
      );
      let renewing = false;
      let renewalAt = 0;
      const leaseTimer = setInterval(() => {
        if (performance.now() >= Math.min(leaseUntil, deadline)) {
          cancel.abort();
          return;
        }
        if (renewing || performance.now() - renewalAt < 5000) return;
        renewing = true;
        renewalAt = performance.now();
        void request(
          `/attempts/${assignment.attemptId}/renew`,
          {},
          cancel.signal,
        )
          .then((lease) => {
            const next = monotonicExpiry(lease.leaseUntil);
            if (!Number.isFinite(next)) cancel.abort();
            else leaseUntil = Math.min(next, deadline);
          })
          .catch((error) => {
            if (
              error instanceof ControlError &&
              [401, 403, 404, 409, 410].includes(error.status)
            )
              cancel.abort();
          })
          .finally(() => {
            renewing = false;
          });
      }, 250);
      /**
       * Report whether this attempt remains uncancelled and inside both its lease and fixed
       * deadline.
       */
      const owns = async () =>
        !cancel.signal.aborted &&
        performance.now() < Math.min(leaseUntil, deadline);
      const root = `${url}/api/runner/attempts/${assignment.attemptId}`;
      const execution = {
        ...c,
        ...(assignment.agent
          ? {
              endpoint: `${root}/model/v1/${assignment.agent.provider === "anthropic" ? "messages" : "responses"}`,
              apiKey: assignment.capabilityToken,
              model: {
                ...c.model,
                // The broker owns provider retries; this hop waits within the attempt
                // deadline instead of cutting off or multiplying that retry sequence.
                max_retries: 0,
                timeout_ms: c.runner.timeout_ms,
                provider: assignment.agent.provider,
                model: assignment.agent.model,
                reasoning_effort:
                  assignment.agent.reasoningEffort ?? c.model.reasoning_effort,
              },
            }
          : {}),
      };
      let logs = Promise.resolve();
      const progress = new AttemptProgress();
      /**
       * Queue at most 500 full progress messages in order, then forward changed
       * validated cumulative metrics without repeated messages. Delivery failures
       * remain best effort; a separately retained final snapshot repairs intermediate
       * transport gaps when the outcome is accepted. Ownership expiry suppresses sends.
       */
      const onProgress = (event: ReviewProgress) => {
        const payload = progress.capture(event);
        if (!payload) return;
        logs = logs
          .then(async () => {
            if (await owns())
              await request(
                `/attempts/${assignment.attemptId}/progress`,
                { events: [payload] },
                cancel.signal,
              );
          })
          .catch(() => {});
      };
      /**
       * Retry the same immutable outcome on transient transport or server failures,
       * while the attempt remains owned. A lost success acknowledgement never changes
       * the outcome to failure, and snapshot replay cannot double-count usage.
       */
      const reportOutcome = async (outcome: AttemptCompletion) => {
        for (let delivery = 0; delivery < 3; delivery++) {
          if (!(await owns()))
            throw new Error("Attempt expired before completion delivery");
          try {
            return await request(
              `/attempts/${assignment.attemptId}/result`,
              outcome,
              cancel.signal,
            );
          } catch (error) {
            if (
              delivery === 2 ||
              cancel.signal.aborted ||
              (error instanceof ControlError &&
                error.status !== 429 &&
                error.status < 500)
            )
              throw error;
            await delay(250 * 2 ** delivery, undefined, {
              signal: cancel.signal,
            });
          }
        }
      };
      try {
        let outcome: AttemptCompletion;
        try {
          const result = await execute(
            execution,
            docker,
            relay!,
            relayHost,
            assignment.job,
            {
              attemptId: assignment.attemptId,
              signal: cancel.signal,
              owns,
              onProgress,
              remote: {
                source: {
                  url: `${root}/source`,
                  token: assignment.capabilityToken,
                },
                index: assignment.index
                  ? { ...assignment.index, endpoint: `${root}/mcp` }
                  : undefined,
                memory: assignment.memory
                  ? { ...assignment.memory, endpoint: `${root}/memory` }
                  : undefined,
                mcpServers: assignment.job.mcpServers?.map((server) => ({
                  ...server,
                  endpoint: `${root}/mcp/${server.id}`,
                  queryMs: 15000,
                })),
              },
            },
          );
          outcome = { result };
        } catch (error) {
          outcome = {
            failed: true,
            terminal: error instanceof PermanentError,
          };
          logger.warn(
            { attemptId: assignment.attemptId },
            "Review attempt ended without an accepted result",
          );
        }
        await logs;
        if (await owns())
          await reportOutcome({ ...outcome, metrics: progress.metrics });
      } catch {
        logger.warn(
          { attemptId: assignment.attemptId },
          "Review attempt completion delivery unavailable",
        );
      } finally {
        clearInterval(leaseTimer);
        cancel.abort();
      }
    };
    logger.info(
      { runnerId: c.runner.name, concurrency: c.runner.concurrency },
      "Enrolled runner ready",
    );
    while (!stop.signal.aborted) {
      try {
        if (performance.now() - lastHeartbeat >= 10000) {
          const heartbeat = await request("/heartbeat", session);
          sessionUntil = monotonicExpiry(heartbeat.sessionExpiresAt);
          lastHeartbeat = performance.now();
        }
        if (
          performance.now() < sessionUntil &&
          active.size < c.runner.concurrency
        ) {
          const claimed = await request("/claim", {
            activeAttemptIds: [...active.keys()],
            modelPolicy: {
              supports_tools: c.model.supports_tools,
              reasoning_effort: c.model.reasoning_effort,
              max_requests: c.model.max_requests,
              max_retries: c.model.max_retries,
              max_request_bytes: c.model.max_request_bytes,
              max_response_bytes: c.model.max_response_bytes,
              max_output_tokens: c.model.max_output_tokens,
              timeout_ms: c.model.timeout_ms,
            },
          });
          if (claimed.assignment) {
            const assignment = assignmentSchema.parse(claimed.assignment);
            const cancel = new AbortController();
            const done = run(assignment, cancel).finally(() =>
              active.delete(assignment.attemptId),
            );
            active.set(assignment.attemptId, { cancel, done });
            continue;
          }
        }
      } catch (error) {
        if (stop.signal.aborted) break;
        if (
          error instanceof ControlError &&
          [401, 403].includes(error.status)
        ) {
          for (const attempt of active.values()) attempt.cancel.abort();
          throw error;
        }
        logger.warn(
          "Runner control plane unavailable; active work remains bounded by its lease",
        );
      }
      await delay(1000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    const hardStop = setTimeout(() => {
      for (const attempt of active.values()) attempt.cancel.abort();
      guard.stdin.end();
      process.exit(1);
    }, c.runner.shutdown_grace_ms + 15000);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...active.values()].map((a) => a.done)),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, c.runner.shutdown_grace_ms);
      }),
    ]);
    clearTimeout(drainTimer);
    for (const attempt of active.values()) attempt.cancel.abort();
    await Promise.allSettled([...active.values()].map((a) => a.done));
    await relay?.close();
    guard.stdin.end();
    clearTimeout(hardStop);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

try {
  await main();
} catch (error) {
  logger.error(
    {
      configurationIssues:
        error instanceof ZodError
          ? error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            }))
          : undefined,
      reason:
        error instanceof PermanentError
          ? error.message
          : "Check runner enrollment, HTTPS connectivity, local runtime, Docker and configuration",
    },
    "Runner stopped",
  );
  logger.flush();
  process.exitCode = 1;
}
