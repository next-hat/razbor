import path from "node:path";
import { constants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";

import { z } from "zod";
import Docker from "dockerode";

import { errorDetails, logger } from "@razbor/harness/logger";
import { RepositoryTools } from "@razbor/harness/repository";
import {
  queueJobSchema,
  reviewResultSchema,
  validateFindingChecks,
  type ReviewProgress,
  type QueueJob,
  type McpServerSnapshot,
} from "@razbor/contracts";

import { containerOptions } from "@runner/src/docker.js";
import { followProgress } from "@runner/src/progress.js";
import type { ResolvedConfig } from "@runner/src/config.js";
import {
  createWorkspace,
  prepareWorkspace,
  removeWorkspace,
  type Workspace,
} from "@runner/src/workspace.js";
import { ModelRelay } from "@runner/src/relay.js";
import { PermanentError, aborted } from "@runner/src/errors.js";

/** Poll Docker until the agent exits, checking attempt cancellation between inspections. */
async function waitForContainer(
  container: Docker.Container,
  signal: AbortSignal,
) {
  for (;;) {
    aborted(signal);
    const result = await container.inspect();
    if (!result.State.Running) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Read a bounded regular result file without following symlinks, validate its review
 * identity and finding lifecycle, and resolve every finding path inside the checkout.
 */
async function readAgentResult(w: Workspace, job: QueueJob) {
  const file = await open(
    path.join(w.root, "output/result.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let review;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1000000)
      throw new Error("invalid result file");
    const envelope = z
      .object({
        reviewId: z.literal(job.reviewId),
        review: reviewResultSchema,
      })
      .strict()
      .parse(JSON.parse(await file.readFile("utf8")));
    review = envelope.review;
    validateFindingChecks(review, job.previousFindings, !!job.conversation);
    const files = new RepositoryTools(w.repository);
    for (const finding of review.findings)
      await files.resolveRepositoryFile(finding.path);
  } catch {
    throw new PermanentError("invalid agent result");
  } finally {
    await file.close();
  }
  return review;
}

/** Describe an OOM or SIGKILL exit without inferring an unreported memory failure. */
function exitReason(state: Docker.ContainerInspectInfo["State"]) {
  if (state.OOMKilled) return " (memory limit exceeded)";
  return state.ExitCode === 137 ? " (SIGKILL; Docker did not report OOM)" : "";
}

/**
 * Expose cancellation and approved permanent errors while keeping arbitrary infrastructure
 * error details out of review progress.
 */
function failureMessage(
  error: unknown,
  signal: AbortSignal,
  phase: ReviewProgress["stage"],
) {
  if (signal.aborted) return "Attempt cancelled or deadline exceeded";
  return error instanceof PermanentError
    ? error.message
    : `Attempt failed during ${phase}; check runner infrastructure diagnostics`;
}

/**
 * Execute one leased attempt from source preparation through validated output. Recheck
 * ownership throughout, revoke relay access on exit, and remove workspace mounts only after
 * Docker confirms container removal.
 */
export async function execute(
  c: ResolvedConfig,
  docker: Docker,
  relay: ModelRelay,
  relayHost: string,
  input: unknown,
  options: {
    signal: AbortSignal;
    owns: () => Promise<boolean>;
    attemptId: string;
    onProgress?: (event: ReviewProgress) => void;
    remote: {
      source: { url: string; token: string };
      index?: {
        project: string;
        indexHeadSha: string;
        indexBranch: string;
        queryMs: number;
        endpoint: string;
      };
      memory?: { endpoint: string; queryMs: number };
      mcpServers?: (McpServerSnapshot & {
        endpoint: string;
        queryMs: number;
      })[];
    };
  },
) {
  const { owns, attemptId, onProgress } = options;
  let { signal } = options;
  const parsed = queueJobSchema.safeParse(input);
  if (!parsed.success) throw new PermanentError("invalid queue job");
  const job = parsed.data;
  if (!c.endpoint || !c.apiKey || !c.model.model)
    throw new PermanentError(
      "No AI reviewer is assigned to this review and no legacy runner model is configured",
    );
  const w = await createWorkspace(c, attemptId);
  const log = logger.child({
    runnerId: c.runner.name,
    reviewId: job.reviewId,
    attemptId: w.id,
  });
  const ownership = new AbortController();
  signal = AbortSignal.any([signal, ownership.signal]);
  let checkingOwnership = false;
  const ownershipTimer = setInterval(() => {
    if (checkingOwnership || signal.aborted) return;
    checkingOwnership = true;
    void owns()
      .then((owned) => {
        if (!owned) ownership.abort(new Error("Attempt lost ownership"));
      })
      .catch(() => ownership.abort(new Error("Attempt ownership unavailable")))
      .finally(() => {
        checkingOwnership = false;
      });
  }, 1000).unref();
  const start = performance.now();
  const queueWaitMs = Math.max(0, Date.now() - Date.parse(job.submittedAt));
  let container: Docker.Container | undefined;
  let revoke: (() => void) | undefined;
  let modelToken: string | undefined;
  let finalState = "failed";
  let executionStart = start;
  let phase: ReviewProgress["stage"] = "prepare";
  let output: Awaited<ReturnType<typeof followProgress>> | undefined;
  /**
   * Log approved progress metadata and attach the active model and turn budget before
   * forwarding the event.
   */
  const report = (event: ReviewProgress) => {
    const level =
      event.detail && event.level === "info" ? "debug" : event.level;
    log[level](
      {
        source: event.source,
        stage: event.stage,
        turn: event.turn,
        toolCalls: event.toolCalls,
        tool: event.tool,
      },
      event.message,
    );
    onProgress?.({
      ...event,
      model: c.model.model,
      maxTurns: c.model.max_requests,
    });
  };
  /**
   * Emit a timestamped progress event for the current execution phase, optionally
   * invalidating token coverage after interrupted execution or a progress transport gap.
   */
  const progress = (
    message: string,
    level: ReviewProgress["level"] = "info",
    tokenUsageComplete?: false,
  ) =>
    report({
      time: new Date().toISOString(),
      source: "runner",
      stage: phase,
      level,
      message,
      tokenUsageComplete,
    });
  try {
    progress(
      `Attempt started · queue wait ${(queueWaitMs / 1000).toFixed(1)}s`,
    );
    progress("Downloading assigned repository source");
    await prepareWorkspace(c, w, job, signal, options.remote.source);
    progress("Repository checkout and approved capability files ready");
    if (
      options.remote.index ||
      options.remote.memory ||
      options.remote.mcpServers?.length
    ) {
      const file = path.join(w.root, "input/job.json");
      const input = JSON.parse(await readFile(file, "utf8"));
      input.capabilities ??= { instructions: [], skills: [], limits: {} };
      if (options.remote.index) {
        const index = options.remote.index;
        input.capabilities.codebaseMemory = {
          project: index.project,
          indexHeadSha: index.indexHeadSha,
          indexBranch: index.indexBranch,
          queryMs: index.queryMs,
          endpoint: `http://${relayHost}:${c.model.relay_port}/mcp`,
          tokenEnv: "RAZBOR_MCP_TOKEN",
          startupMs: 15000,
        };
        w.mcpToken = options.remote.source.token;
      }
      if (options.remote.memory) {
        input.capabilities.memory = {
          endpoint: `http://${relayHost}:${c.model.relay_port}/memory`,
          tokenEnv: "RAZBOR_MEMORY_TOKEN",
          queryMs: options.remote.memory.queryMs,
        };
        w.memoryEnabled = true;
      }
      if (options.remote.mcpServers?.length) {
        input.capabilities.mcpServers = options.remote.mcpServers.map(
          (server) => ({
            id: server.id,
            name: server.name,
            endpoint: `http://${relayHost}:${c.model.relay_port}/mcp/${server.id}`,
            tokenEnv: "RAZBOR_MCP_TOKEN",
            startupMs: 15000,
            queryMs: server.queryMs,
          }),
        );
        w.mcpToken = options.remote.source.token;
      }
      await writeFile(file, JSON.stringify(input));
    }
    aborted(signal);
    if (!(await owns())) throw new Error("attempt lost ownership");
    const access = relay.issue(
      signal,
      options.remote.index
        ? {
            token: options.remote.source.token,
            endpoint: options.remote.index.endpoint,
            queryMs: options.remote.index.queryMs,
          }
        : undefined,
      (message, level = "error") =>
        report({
          time: new Date().toISOString(),
          source: "runner",
          stage: "model",
          level,
          message,
        }),
      c,
      options.remote.memory
        ? {
            token: options.remote.source.token,
            endpoint: options.remote.memory.endpoint,
            queryMs: options.remote.memory.queryMs,
          }
        : undefined,
      options.remote.mcpServers?.map((server) => ({
        id: server.id,
        endpoint: server.endpoint,
        token: options.remote.source.token,
        queryMs: server.queryMs,
      })),
    );
    revoke = access.revoke;
    modelToken = access.token;
    log.info(
      {
        preparationMs: Math.round(performance.now() - start),
        queueWaitMs,
      },
      "attempt prepared",
    );
    phase = "agent";
    progress(
      `Creating agent container · ${c.docker.cpus} CPUs · ${c.docker.memory_mb} MiB memory`,
    );
    container = await docker.createContainer(
      containerOptions(c, w, job.reviewId, relayHost, access.token),
    );
    aborted(signal);
    await container.start();
    output = await followProgress(docker, container, signal, report).catch(
      () => {
        progress(
          "Unable to attach agent log stream; container exit will still be reported",
          "warn",
          false,
        );
        return undefined;
      },
    );
    progress("Agent container started; following execution");
    executionStart = performance.now();
    log.info({ containerId: container.id }, "agent started");
    const result = await waitForContainer(container, signal);
    aborted(signal);
    // Drain the final progress lines before declaring the attempt finished.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      output?.done ?? Promise.resolve(),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
          progress(
            "Agent progress drain timed out; token usage may be incomplete",
            "warn",
            false,
          );
          resolve();
        }, 2000);
      }),
    ]);
    clearTimeout(drainTimer);
    progress(
      `Agent exited with code ${result.State.ExitCode} · OOM killed: ${result.State.OOMKilled ? "yes" : "no"}`,
      result.State.ExitCode === 0 ? "info" : "error",
      result.State.ExitCode === 0 && !result.State.OOMKilled
        ? undefined
        : false,
    );
    if (result.State.ExitCode !== 0)
      throw new PermanentError(
        `Agent exited with code ${result.State.ExitCode}${exitReason(result.State)}`,
      );
    phase = "result";
    progress("Reading and validating agent result");
    const review = await readAgentResult(w, job);
    aborted(signal);
    if (!(await owns())) throw new Error("attempt lost ownership");
    finalState = "completed";
    progress(`Result validated · ${review.findings.length} findings`);
    return review;
  } catch (error) {
    log.warn(
      {
        phase,
        durationMs: Math.round(performance.now() - start),
        cancelled: signal.aborted,
        error: errorDetails(error, [
          options.remote.source.token,
          c.apiKey,
          modelToken ?? "",
        ]),
      },
      "attempt execution failed",
    );
    // Interrupted execution may leave a billed model response outside the last
    // received snapshot, even when Docker closes its log stream normally.
    progress(
      failureMessage(error, signal, phase),
      "error",
      phase === "agent" ? false : undefined,
    );
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new PermanentError("missing agent result or runtime file");
    throw error;
  } finally {
    clearInterval(ownershipTimer);
    output?.close();
    phase = "cleanup";
    progress("Revoking local relay access and removing agent workspace");
    revoke?.();
    // Do not delete mounts until Docker confirms the container is gone.
    if (container)
      await container.remove({ force: true }).catch((error) => {
        progress(
          "Agent container removal failed; workspace retained for reconciliation",
          "error",
        );
        throw error;
      });
    await removeWorkspace(c, w).catch((error) => {
      progress(
        "Workspace cleanup failed; remaining files require runner reconciliation",
        "error",
      );
      throw error;
    });
    progress(
      `Execution ${finalState} · total ${((performance.now() - start) / 1000).toFixed(1)}s`,
      finalState === "completed" ? "info" : "warn",
    );
    log.info(
      {
        containerId: container?.id,
        finalState,
        executionMs: Math.round(performance.now() - executionStart),
        durationMs: Math.round(performance.now() - start),
      },
      "attempt finished",
    );
  }
}
