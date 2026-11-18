import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { publicIdSchema } from "@razbor/contracts";
import {
  assertRepositoryActive,
  type Database,
  type WorkspacePolicy,
} from "@razbor/database";
import { git, gitEnvironment, safeGitOptions } from "@razbor/harness/git";

import type { IndexerConfig } from "@indexer/src/config.js";
import { GitSource } from "@indexer/src/source.js";

/** Check existing directories without following symlinks; cleanup may encounter absent storage. */
async function validateDirectory(directory: string, allowMissing = false) {
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    stat &&
    (!stat.isDirectory() || (await realpath(directory)) !== directory)
  )
    throw new Error("workspace storage must use canonical directories");
}

/** Create one child of a verified directory, refusing pre-existing links and non-directories. */
async function ensureDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await validateDirectory(directory);
}

/** Verify the exact ID-to-path binding and canonical parents before using stored workspace data. */
export async function validateWorkspaceStorage(
  dataRoot: string,
  workspace: { id: string; root: string; temporary: boolean },
  createParent = false,
) {
  publicIdSchema("workspace").parse(workspace.id);
  const parent = path.join(
    dataRoot,
    workspace.temporary ? "reviews" : "development",
  );
  if (workspace.root !== path.join(parent, workspace.id))
    throw new Error("workspace storage ownership mismatch");
  await validateDirectory(dataRoot);
  if (createParent) await ensureDirectory(parent);
  else await validateDirectory(parent, true);
  await validateDirectory(workspace.root, true);
}

/** Serialize access and cleanup for a service-owned Git checkout. */
export abstract class OwnedWorkspace {
  private tail: Promise<unknown> = Promise.resolve();
  protected readonly stop = new AbortController();
  readonly source: GitSource;
  abstract readonly temporary: boolean;

  /** Bind Git commands to the approved checkout, credential policy and synchronization deadline. */
  constructor(
    readonly id: string,
    readonly root: string,
    readonly repositoryId: string,
    protected readonly config: IndexerConfig,
    readonly policy: WorkspacePolicy,
    protected readonly database: Database,
  ) {
    this.source = new GitSource(
      path.join(root, "repository"),
      policy,
      config.service.sync_ms,
      database,
    );
  }

  /** Recheck the filesystem ownership boundary for this operation. */
  protected validateStorage(createParent = false) {
    return validateWorkspaceStorage(
      this.config.service.data_root,
      this,
      createParent,
    );
  }

  /**
   * Queue one workspace operation at a time while allowing later cleanup or retries to
   * proceed after a rejected operation.
   */
  protected serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Abort current and queued workspace operations through the shared lifetime signal. */
  cancel() {
    this.stop.abort(new Error("workspace revoked"));
  }
}

/** Temporary checkout for one attempt. Only its pinned Git objects leave this process. */
export class ReviewWorkspace extends OwnedWorkspace {
  readonly temporary = true;
  private revision?: { baseSha: string; headSha: string };

  /**
   * Serialize creation of an exact temporary review checkout under repository authorization,
   * cancellation, and the synchronization deadline.
   */
  async prepareReviewSource(
    signal: AbortSignal,
    revision: { baseSha: string; headSha: string },
  ) {
    return this.serial(async () => {
      const active = AbortSignal.any([
        signal,
        this.stop.signal,
        AbortSignal.timeout(this.config.service.sync_ms),
      ]);
      active.throwIfAborted();
      await this.validateStorage(true);
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
      );
      await this.source.review(revision.baseSha, revision.headSha, active);
      this.revision = { baseSha: revision.baseSha, headSha: revision.headSha };
    });
  }

  /**
   * Serialize a bounded Git pack stream for the exact base and head commits, checking
   * the bound grant immediately before pack generation and waiting for the Git child to exit.
   */
  async streamReviewSource(
    response: ServerResponse,
    signal: AbortSignal,
    authorize: () => Promise<unknown>,
  ) {
    return this.serial(async () => {
      const active = AbortSignal.any([
        signal,
        this.stop.signal,
        AbortSignal.timeout(30000),
      ]);
      active.throwIfAborted();
      await this.validateStorage();
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
      );
      const revision = this.revision;
      if (!revision) throw new Error("review source unavailable");
      for (const sha of [revision.baseSha, revision.headSha])
        if (
          (await git(
            this.source.repository,
            ["rev-parse", "--verify", `${sha}^{commit}`],
            active,
          )) !== sha
        )
          throw new Error("source revision mismatch");
      const format = await git(
        this.source.repository,
        ["rev-parse", "--show-object-format"],
        active,
      );
      await authorize();
      active.throwIfAborted();
      const child = spawn(
        "git",
        [
          ...safeGitOptions,
          "-C",
          this.source.repository,
          "pack-objects",
          "--stdout",
          "--revs",
        ],
        {
          env: gitEnvironment,
          stdio: ["pipe", "pipe", "ignore"],
          signal: active,
          timeout: 30000,
        },
      );
      const done = new Promise<void>((resolve, reject) => {
        let failure: Error | undefined;
        // An abort can emit an error before the child has actually exited.
        // Retain workspace ownership until its process and pipes have closed.
        child.once("error", (error) => {
          failure = error;
        });
        child.stdin.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) =>
          code === 0 && !failure
            ? resolve()
            : reject(failure ?? new Error("source pack failed")),
        );
      });
      // Attach a rejection handler immediately while the stream is being consumed.
      void done.catch(() => response.destroy());
      child.stdin.end(`${revision.baseSha}\n${revision.headSha}\n`);
      response.writeHead(200, {
        "content-type": "application/x-git-packed-objects",
        "cache-control": "no-store",
        "x-razbor-object-format": format,
      });
      try {
        await pipeline(
          child.stdout,
          async function* (chunks) {
            let bytes = 0;
            for await (const chunk of chunks) {
              bytes += chunk.length;
              if (bytes > 512 * 1024 * 1024)
                throw new Error("source pack exceeds limit");
              yield chunk;
            }
          },
          response,
          { signal: active },
        );
        await done;
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await done.catch(() => {});
      }
    });
  }

  /** Interrupt active work and wait for its Git subprocesses before deleting the checkout. */
  async close() {
    this.cancel();
    await this.serial(async () => {
      await this.validateStorage();
      await rm(this.root, { recursive: true, force: true });
    });
  }
}

/**
 * Require canonical storage for the service lock and temporary checkouts. Each
 * persistent index verifies its storage separately before use.
 */
export async function prepareDataRoot(config: IndexerConfig) {
  const root = config.service.data_root;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await validateDirectory(root);
  await ensureDirectory(path.join(root, "reviews"));
  const lock = await lstat(path.join(root, "service.lock")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (lock && !lock.isFile())
    throw new Error("invalid source service lock file");
}
