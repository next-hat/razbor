import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { mkdir, realpath, rm, lstat } from "node:fs/promises";
import path from "node:path";

import type { IndexPreparation } from "@razbor/contracts";
import {
  workspaceState,
  assertRepositoryActive,
  type Database,
  type WorkspacePolicy,
} from "@razbor/database";
import { deleteEmbeddingIndex } from "@razbor/database/embeddings";
import { git, gitEnvironment, safeGitOptions } from "@razbor/harness/git";
import { errorDetails, logger } from "@razbor/harness/logger";

import { MemoryBackend } from "@indexer/src/backend.js";
import type { Embeddings } from "@indexer/src/embeddings.js";
import { SemanticIndex, semanticSearchTool } from "@indexer/src/semantic.js";
import { DocumentIndex, documentSearchTool } from "@indexer/src/documents.js";
import type { IndexerConfig } from "@indexer/src/config.js";
import { GitSource, WorkspaceDivergedError } from "@indexer/src/source.js";

// One operation owns a workspace at a time, including queries and cleanup.
export class IndexWorkspace {
  private tail: Promise<unknown> = Promise.resolve();
  private backend?: MemoryBackend;
  private backendInitialized = false;
  private readonly stop = new AbortController();
  private readyHead?: string;
  private readonly semantic?: SemanticIndex;
  private readonly documents?: DocumentIndex;
  readonly source: GitSource;

  readonly branch: string;

  /**
   * Bind a workspace to approved Git policy and optional semantic/document indexes;
   * temporary review checkouts remain separate from shared indexes.
   */
  constructor(
    readonly id: string,
    readonly root: string,
    readonly repositoryId: string,
    private readonly config: IndexerConfig,
    readonly temporary: boolean,
    readonly policy: WorkspacePolicy,
    private readonly database: Database,
    embeddings?: Embeddings,
  ) {
    this.branch = policy.branch;
    this.source = new GitSource(
      path.join(root, "repository"),
      policy,
      config.service.sync_ms,
      database,
    );
    if (embeddings) {
      this.semantic = new SemanticIndex(
        database,
        {
          owner: config.service.owner,
          workspaceId: id,
          repositoryId,
        },
        config,
        embeddings,
      );
      this.documents = new DocumentIndex(
        database,
        { owner: config.service.owner, workspaceId: id, repositoryId },
        config,
        embeddings,
      );
    }
  }

  /**
   * Queue one workspace operation at a time while allowing later cleanup or retries to
   * proceed after a rejected operation.
   */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  /**
   * Close the active backend before clearing its reference, retaining it when shutdown fails
   * so cleanup can retry.
   */
  private async closeBackend() {
    const backend = this.backend;
    if (backend) {
      await backend.close();
      this.backend = undefined;
    }
  }

  /**
   * Serialize creation of an exact temporary review checkout under repository authorization,
   * cancellation, and the synchronization deadline.
   */
  async prepareReviewSource(
    signal: AbortSignal,
    revision: { baseSha: string; headSha: string },
  ) {
    return this.serial(async () => {
      if (!this.temporary) throw new Error("review checkout required");
      const active = AbortSignal.any([
        signal,
        this.stop.signal,
        AbortSignal.timeout(this.config.service.sync_ms),
      ]);
      active.throwIfAborted();
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
      );
      return this.source.review(revision.baseSha, revision.headSha, active);
    });
  }

  /**
   * Serialize a bounded Git pack stream for the exact base and head commits, checking
   * repository state and terminating the Git child before releasing workspace ownership.
   */
  async streamReviewSource(
    response: ServerResponse,
    revision: { baseSha: string; headSha: string },
    signal: AbortSignal,
  ) {
    return this.serial(async () => {
      if (!this.temporary) throw new Error("review checkout required");
      const active = AbortSignal.any([
        signal,
        this.stop.signal,
        AbortSignal.timeout(30000),
      ]);
      active.throwIfAborted();
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
      );
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
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error("source pack failed")),
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

  /**
   * Refresh the shared checkout; only confirmed divergence triggers one clean reclone after
   * stopping the old backend and removing its index state.
   */
  private async refreshSource(active: AbortSignal) {
    try {
      return await this.source.refresh(active);
    } catch (error) {
      if (!(error instanceof WorkspaceDivergedError)) throw error;
      active.throwIfAborted();
      logger.warn(
        { workspaceId: this.id, repositoryId: this.repositoryId },
        "workspace diverged from upstream; rebuilding checkout and index",
      );
      const state = path.join(this.root, "state");
      // A previous service process may have left an isolated daemon alive.
      if (
        !this.backend &&
        !this.backendInitialized &&
        (await lstat(state).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        ))
      )
        this.backend = new MemoryBackend(
          this.config.memory,
          this.source.repository,
          state,
          this.id,
          false,
        );
      await this.closeBackend();
      await rm(state, { recursive: true, force: true });
      // One recovery attempt; clone/index failures remain visible and unready.
      return this.source.reclone(active);
    }
  }

  /**
   * Serialize shared-checkout refresh and graph/embedding preparation, publishing readiness
   * only for a validated clean revision and invalidating failed preparations. Report phase
   * and completed corpus counts under the bounded preparation deadline, capped at one hour.
   */
  async prepare(
    signal: AbortSignal,
    reuseReady = false,
    reportProgress?: (progress: Partial<IndexPreparation>) => void,
  ) {
    return this.serial(async () => {
      if (this.temporary) throw new Error("shared index workspace required");
      const timeoutMs = Math.min(
        3600000,
        this.config.service.sync_ms +
          this.config.memory.index_ms +
          this.config.memory.startup_ms +
          (this.config.embeddings?.index_ms ?? 0) +
          30000,
      );
      const deadline = AbortSignal.timeout(timeoutMs);
      const active = AbortSignal.any([signal, this.stop.signal, deadline]);
      reportProgress?.({
        state: "running",
        phase: "graph_readiness",
        deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      });
      active.throwIfAborted();
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
      );
      if (reuseReady && this.backend && this.readyHead) {
        reportProgress?.({ phase: "source_validation" });
        if ((await this.source.head(active)) !== this.readyHead)
          throw new Error("workspace revision changed; refresh required");
        await this.source.clean(active);
        reportProgress?.({
          code: {
            processed: this.semantic?.status?.chunkCount ?? 0,
            total: this.semantic?.status?.chunkCount ?? 0,
          },
          documents: {
            processed: this.documents?.status?.chunkCount ?? 0,
            total: this.documents?.status?.chunkCount ?? 0,
          },
        });
        return { headSha: this.readyHead, project: this.backend.project };
      }
      const previousHead = this.readyHead;
      this.readyHead = undefined;
      this.semantic?.reset();
      this.documents?.reset();
      await workspaceState(
        this.database,
        this.config.service.owner,
        this.id,
        "unready",
      );
      const started = performance.now();
      let phase = "graph_readiness";
      let phaseTimeoutMs: number | undefined = this.config.memory.index_ms;
      /** Record the current preparation phase without estimating corpus completeness. */
      const updatePhase = (
        next: IndexPreparation["phase"],
        budget?: number,
      ) => {
        phase = next;
        phaseTimeoutMs = budget;
        reportProgress?.({ phase: next });
      };
      try {
        const previousIndex = await this.backend?.waitForIndex(active);
        updatePhase("source_sync", this.config.service.sync_ms);
        const head = await this.refreshSource(active);
        let indexedAt: Date;
        if (!this.backend) {
          updatePhase(
            "graph_bootstrap",
            this.config.memory.startup_ms + this.config.memory.index_ms,
          );
          this.backendInitialized = true;
          this.backend = new MemoryBackend(
            this.config.memory,
            this.source.repository,
            path.join(this.root, "state"),
            this.id,
            true,
          );
          indexedAt = await this.backend.start(active);
        } else {
          updatePhase("graph_readiness", this.config.memory.index_ms);
          await this.backend.validateSource(active);
          // Keep the MCP session alive: its Git watcher notices the new HEAD.
          // Queries remain serialized until a newer index has been published.
          indexedAt = await this.backend.waitForIndex(
            active,
            head !== previousHead ? previousIndex : undefined,
          );
        }
        updatePhase("source_validation");
        if ((await this.source.head(active)) !== head)
          throw new Error("source changed during indexing");
        await this.source.clean(active);
        if (this.semantic) {
          updatePhase("semantic_index", this.config.embeddings?.index_ms);
          await this.semantic.prepare(
            this.backend,
            head,
            active,
            async () => {
              if ((await this.source.head(active)) !== head)
                throw new Error("source changed during semantic indexing");
              await this.source.clean(active);
            },
            (code) => reportProgress?.({ code }),
          );
        }
        if (this.documents) {
          updatePhase("document_index", this.config.embeddings?.index_ms);
          await this.documents.prepare(
            this.source.repository,
            head,
            active,
            async () => {
              if ((await this.source.head(active)) !== head)
                throw new Error("source changed during document indexing");
              await this.source.clean(active);
            },
            (documents) => reportProgress?.({ documents }),
          );
        }
        updatePhase("readiness_publication");
        active.throwIfAborted();
        await workspaceState(
          this.database,
          this.config.service.owner,
          this.id,
          "ready",
          head,
          indexedAt,
        );
        this.readyHead = head;
        logger.info(
          {
            workspaceId: this.id,
            repositoryId: this.repositoryId,
            headSha: head,
            project: this.backend.project,
            durationMs: Math.round(performance.now() - started),
          },
          "workspace index ready",
        );
        return { headSha: head, project: this.backend.project };
      } catch (error) {
        // Record the original failure before backend cleanup can fail or replace it.
        const errorCode: IndexPreparation["errorCode"] =
          signal.aborted || this.stop.signal.aborted
            ? "cancelled"
            : deadline.aborted ||
                (error instanceof Error && error.name === "TimeoutError") ||
                (typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "REQUEST_TIMEOUT")
              ? "timeout"
              : "failed";
        logger.warn(
          {
            workspaceId: this.id,
            repositoryId: this.repositoryId,
            project: this.backend?.project,
            phase,
            phaseTimeoutMs,
            timeoutMs,
            durationMs: Math.round(performance.now() - started),
            cancelled: signal.aborted || this.stop.signal.aborted,
            deadlineExceeded: deadline.aborted,
            error: errorDetails(error),
          },
          "workspace index preparation failed",
        );
        this.semantic?.reset();
        this.documents?.reset();
        // Cleanup retains its backend reference on failure, allowing a later retry.
        // Preserve the preparation cause for diagnostics rather than replacing it.
        try {
          await this.closeBackend();
        } catch (cleanupError) {
          logger.warn(
            { workspaceId: this.id, error: errorDetails(cleanupError) },
            "index preparation cleanup will retry",
          );
        }
        reportProgress?.({ errorCode });
        throw error;
      }
    });
  }

  /**
   * Expose the backend tools plus semantic and document search only when their indexes are
   * prepared.
   */
  tools(backend: MemoryBackend) {
    return [
      ...backend.bound!.tools,
      ...(this.semantic?.status ? [semanticSearchTool] : []),
      ...(this.documents?.status ? [documentSearchTool] : []),
    ];
  }

  /**
   * Dispatch graph, code-semantic, or document queries and augment JSON index status with
   * the workspace’s pinned revision and retrieval readiness.
   */
  async query(
    backend: MemoryBackend,
    head: string,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ) {
    if (name === "search_documents") {
      if (!this.documents) throw new Error("document search is disabled");
      return this.documents.search(
        head,
        input,
        signal,
        this.config.memory.tool_output_bytes,
      );
    }
    if (name === "semantic_search") {
      if (!this.semantic) throw new Error("semantic search is disabled");
      return this.semantic.search(
        head,
        input,
        signal,
        this.config.memory.tool_output_bytes,
      );
    }
    const text = await backend.query(name, input, signal);
    if (
      name === "index_status" &&
      input &&
      typeof input === "object" &&
      "format" in input &&
      input.format === "json"
    )
      return JSON.stringify({
        ...JSON.parse(text),
        headSha: head,
        semanticSearch: this.semantic?.status ?? { enabled: false },
        documentSearch: this.documents?.status ?? { enabled: false },
      });
    return text;
  }

  /**
   * Run a serialized operation only against a clean ready index, rechecking repository
   * activity and any review-pinned revision before granting backend access.
   */
  async access<T>(
    signal: AbortSignal,
    operation: (
      backend: MemoryBackend,
      head: string,
      signal: AbortSignal,
    ) => Promise<T>,
    expectedHead?: string,
  ) {
    return this.serial(async () => {
      const active = AbortSignal.any([signal, this.stop.signal]);
      active.throwIfAborted();
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
      );
      if (!this.backend || !this.readyHead)
        throw new Error("workspace index is not ready; refresh required");
      if (expectedHead && this.readyHead !== expectedHead)
        throw new Error("shared index revision changed during review");
      if ((await this.source.head(active)) !== this.readyHead) {
        this.readyHead = undefined;
        throw new Error("workspace revision changed; refresh required");
      }
      await this.source.clean(active);
      return operation(this.backend, this.readyHead, active);
    });
  }

  /** Abort current and queued workspace operations through the shared lifetime signal. */
  cancel() {
    this.stop.abort(new Error("workspace revoked"));
  }

  /**
   * Cancel and serialize teardown, stop the backend before removing source, and either
   * delete index/storage state or mark a retained workspace unready.
   */
  async close(deleting = this.temporary) {
    this.cancel();
    await this.serial(async () => {
      this.readyHead = undefined;
      this.semantic?.reset();
      this.documents?.reset();
      if (deleting)
        await deleteEmbeddingIndex(
          this.database,
          this.config.service.owner,
          this.id,
        );
      if (deleting && !this.backend && !this.backendInitialized) {
        const state = path.join(this.root, "state");
        const exists = await lstat(state).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists)
          this.backend = new MemoryBackend(
            this.config.memory,
            this.source.repository,
            state,
            this.id,
            false,
          );
      }
      await this.closeBackend();
      if (!deleting)
        await workspaceState(
          this.database,
          this.config.service.owner,
          this.id,
          "unready",
        );
      if (deleting) await rm(this.root, { recursive: true, force: true });
      logger.info(
        { workspaceId: this.id, temporary: this.temporary },
        "workspace cleanup completed",
      );
    });
  }
}

/**
 * Create private service and workspace parent directories, rejecting paths that resolve
 * through symlinks.
 */
export async function prepareDataRoot(config: IndexerConfig) {
  const root = config.service.data_root;
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== root)
    throw new Error("index data root must not contain symlinks");
  for (const directory of ["reviews", "development"]) {
    const full = path.join(root, directory);
    await mkdir(full, { recursive: true, mode: 0o700 });
    if ((await realpath(full)) !== full)
      throw new Error("index workspace parent must not contain symlinks");
  }
}
