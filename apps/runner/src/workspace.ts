import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream, createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { publicIdSchema, type QueueJob } from "@razbor/contracts";
import { git, gitEnvironment, safeGitOptions } from "@razbor/harness/git";
import { errorDetails, logger } from "@razbor/harness/logger";

import type { ResolvedConfig } from "@runner/src/config.js";
import { isInside } from "@runner/src/config.js";
import { PermanentError, aborted } from "@runner/src/errors.js";
import { prepareCapabilities } from "@runner/src/capabilities.js";

export type Workspace = {
  id: string;
  root: string;
  host: string;
  repository: string;
  mcpToken?: string;
  memoryEnabled?: boolean;
  ripgrepAvailable?: boolean;
};

/**
 * Create private attempt storage after validating its public ID, and derive matching
 * runner-local and Docker-host paths.
 */
export async function createWorkspace(
  c: ResolvedConfig,
  id: string,
): Promise<Workspace> {
  publicIdSchema("attempt").parse(id);
  const root = path.join(c.storage.root, c.runner.name, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return {
    id,
    root,
    host: path.join(c.hostRoot, c.runner.name, id),
    repository: path.join(root, "repository"),
  };
}

/**
 * Delete only the expected attempt directory after validating its ID, exact path, and
 * resolved parent.
 */
export async function removeWorkspace(c: ResolvedConfig, w: Workspace) {
  const expected = path.join(c.storage.root, c.runner.name, w.id);
  if (!publicIdSchema("attempt").safeParse(w.id).success || w.root !== expected)
    throw new Error("unsafe cleanup path");
  const parent = await realpath(path.dirname(expected));
  if (parent !== path.join(await realpath(c.storage.root), c.runner.name))
    throw new Error("unsafe cleanup parent");
  await rm(expected, { recursive: true, force: true });
}

/**
 * Import a downloaded Git pack with strict object validation and a bounded, cancellable
 * child process.
 */
async function importPack(
  repository: string,
  file: string,
  signal: AbortSignal,
  log: typeof logger,
  secrets: readonly string[],
) {
  const start = performance.now();
  const timeoutMs = 30000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = AbortSignal.any([signal, timeout]);
  let stderr = Buffer.alloc(0);
  let stderrTruncated = false;
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;
  const child = spawn(
    "git",
    [...safeGitOptions, "-C", repository, "index-pack", "--strict", "--stdin"],
    {
      env: gitEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      signal: active,
    },
  );
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = Math.max(0, 16384 - stderr.length);
    stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    if (chunk.length > remaining) stderrTruncated = true;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new PermanentError("repository snapshot failed"));
    });
  });
  child.stdout.resume();
  try {
    await Promise.all([
      pipeline(createReadStream(file), child.stdin, { signal: active }),
      done,
    ]);
  } catch (error) {
    // A pipe error can arrive before Git flushes its fatal stderr and exit status.
    if (
      exitCode === undefined &&
      child.exitCode === null &&
      child.signalCode === null &&
      !child.killed
    )
      child.kill();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
    // Drop a truncated final line so a partially captured credential cannot escape redaction.
    const diagnosticStderr = stderrTruncated
      ? stderr.toString("utf8").replace(/[^\n]*$/, "[truncated]")
      : stderr.toString("utf8");
    log.warn(
      {
        operation: "index-pack",
        durationMs: Math.round(performance.now() - start),
        timeoutMs,
        cancelled: signal.aborted,
        timedOut: timeout.aborted,
        exitCode,
        signal: exitSignal,
        killed: child.killed,
        error: errorDetails(error, secrets),
        stderr: errorDetails({ stderr: diagnosticStderr }, secrets).stderr,
      },
      "repository source import failed",
    );
    throw error;
  }
}

/**
 * Copy trusted runtime files with readable permissions, rejecting symlinks and special files
 * instead of following them into unrelated data.
 */
async function snapshotTree(source: string, destination: string) {
  // Reject symlinks in trusted runtime files; do not follow paths into .env/home.
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new PermanentError("unsupported runtime file");
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    for (const entry of await readdir(source))
      await snapshotTree(
        path.join(source, entry),
        path.join(destination, entry),
      );
  } else {
    await cp(source, destination);
    await chmod(destination, 0o644);
  }
}

export type RemoteSource = { url: string; token: string };

/**
 * Download an authenticated source pack without redirects, enforcing object format, a
 * 30-second deadline, and a 512 MiB transfer limit.
 */
async function downloadPack(
  source: RemoteSource,
  file: string,
  signal: AbortSignal,
  log: typeof logger,
  secrets: readonly string[],
) {
  const start = performance.now();
  const timeoutMs = 30000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = AbortSignal.any([signal, timeout]);
  let response: Response | undefined;
  try {
    response = await fetch(source.url, {
      headers: { authorization: `Bearer ${source.token}` },
      redirect: "error",
      signal: active,
    });
    if (!response.ok || !response.body) throw new Error("source unavailable");
    const format = response.headers.get("x-razbor-object-format");
    if (format !== "sha1" && format !== "sha256")
      throw new Error("invalid source format");
    await pipeline(
      response.body,
      async function* (chunks) {
        let size = 0;
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > 512 * 1024 * 1024) throw new Error("source exceeds limit");
          yield chunk;
        }
      },
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
      { signal: active },
    );
    return format;
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    log.warn(
      {
        operation: "download-pack",
        httpStatus: response?.status,
        durationMs: Math.round(performance.now() - start),
        timeoutMs,
        cancelled: signal.aborted,
        timedOut: timeout.aborted,
        error: errorDetails(error, secrets),
      },
      "repository source download failed",
    );
    throw error;
  }
}

/**
 * Import the assigned source pack, verify both exact commits, and prepare the detached
 * checkout, trusted runtime snapshot, capabilities, and agent input.
 */
export async function prepareWorkspace(
  c: ResolvedConfig,
  w: Workspace,
  job: QueueJob,
  signal: AbortSignal,
  source: RemoteSource,
) {
  aborted(signal);
  const log = logger.child({
    runnerId: c.runner.name,
    reviewId: job.reviewId,
    attemptId: w.id,
  });
  const secrets = [source.token, c.apiKey ?? ""];
  const pack = path.join(w.root, "objects.pack");
  const format = await downloadPack(source, pack, signal, log, secrets);
  let baseline: string;
  let operation = "init";
  const start = performance.now();
  try {
    await mkdir(w.repository);
    await git(
      w.repository,
      ["init", `--object-format=${format}`, "--template="],
      signal,
    );
    operation = "index-pack";
    await importPack(w.repository, pack, signal, log, secrets);
    operation = "verify-revisions";
    await rm(pack);
    for (const sha of [job.baseSha, job.headSha])
      if (
        (await git(
          w.repository,
          ["rev-parse", "--verify", `${sha}^{commit}`],
          signal,
        )) !== sha
      )
        throw new Error("source revision mismatch");
    operation = "checkout";
    await git(
      w.repository,
      ["checkout", "--detach", "--force", job.headSha],
      signal,
    );
    operation = "merge-base";
    baseline = await git(
      w.repository,
      ["merge-base", job.baseSha, job.headSha],
      signal,
    );
  } catch (error) {
    if (operation !== "index-pack")
      log.warn(
        {
          operation,
          durationMs: Math.round(performance.now() - start),
          cancelled: signal.aborted,
          error: errorDetails(error, secrets),
        },
        "repository checkout preparation failed",
      );
    aborted(signal);
    throw new PermanentError("invalid revisions or repository history");
  }
  const app = path.join(w.root, "app");
  await mkdir(app);
  await mkdir(path.join(app, "node_modules"));
  for (const file of ["package.json", "tsconfig.base.json", "tsconfig.json"])
    await snapshotTree(
      path.join(c.storage.runtime_root, file),
      path.join(app, file),
    );
  for (const dir of ["apps/agent", "packages/harness", "packages/contracts"]) {
    await mkdir(path.join(app, dir), { recursive: true });
    await snapshotTree(
      path.join(c.storage.runtime_root, dir, "package.json"),
      path.join(app, dir, "package.json"),
    );
    await snapshotTree(
      path.join(c.storage.runtime_root, dir, "src"),
      path.join(app, dir, "src"),
    );
  }
  const runtimeBin = path.join(c.storage.runtime_root, "bin");
  const ripgrep = path.join(runtimeBin, "rg");
  w.ripgrepAvailable = false;
  try {
    const binStat = await lstat(runtimeBin);
    if (binStat.isSymbolicLink() || !binStat.isDirectory())
      throw new PermanentError("unsupported search tool directory");
    const toolStat = await lstat(ripgrep);
    if (toolStat.isSymbolicLink() || !toolStat.isFile())
      throw new PermanentError("unsupported search tool file");
    w.ripgrepAvailable = true;
  } catch (error) {
    // Existing standalone runtimes may omit the optional, operator-owned tool.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (w.ripgrepAvailable) {
    const appBin = path.join(app, "bin");
    await mkdir(appBin);
    await snapshotTree(ripgrep, path.join(appBin, "rg"));
    // Only this trusted binary is executable; source snapshots stay mode 0644.
    await chmod(path.join(appBin, "rg"), 0o555);
  }
  await mkdir(path.join(w.root, "input"));
  await writeFile(
    path.join(w.root, "input/job.json"),
    JSON.stringify({
      version: 1,
      reviewId: job.reviewId,
      repository: "/workspace/repository",
      base: job.baseSha,
      head: job.headSha,
      baseline,
      initialDiffMaxBytes: c.harness.initialDiffMaxBytes,
      maxTurns: c.model.max_requests,
      reviewBudget: {
        ...c.harness.reviewBudget,
        maxOutputTokens: Math.min(
          c.harness.reviewBudget.maxOutputTokens,
          c.model.max_output_tokens,
        ),
      },
      compactionThresholdTokens: c.harness.compactionThresholdTokens,
      supportsTools: c.model.supports_tools,
      previousFindings: job.previousFindings,
      conversation: job.conversation,
      capabilities: await prepareCapabilities(c, w, job, signal),
    }),
  );
  await mkdir(path.join(w.root, "output"), { mode: 0o777 });
  await chmod(path.join(w.root, "output"), 0o777); // isolated per-attempt output, never the socket
  aborted(signal);
}

/**
 * Create runner storage and verify its symlink-free separation from a readable, complete
 * agent runtime before executing attempts.
 */
export async function validateStorage(c: ResolvedConfig) {
  await mkdir(c.storage.root, { recursive: true });
  if ((await realpath(c.storage.root)) !== c.storage.root)
    throw new PermanentError("storage root must not contain symlinks");
  const runtime = await realpath(c.storage.runtime_root);
  if (isInside(runtime, c.storage.root) || isInside(c.storage.root, runtime))
    throw new PermanentError("overlapping storage paths");
  for (const file of [
    "apps/agent/src/index.ts",
    "packages/harness/src/index.ts",
    "packages/contracts/src/index.ts",
    "node_modules/tsx/package.json",
  ])
    await readFile(path.join(c.storage.runtime_root, file));
  const owned = path.join(c.storage.root, c.runner.name);
  await mkdir(owned, { recursive: true });
  if ((await realpath(owned)) !== owned)
    throw new PermanentError("runner storage must not be a symlink");
}
