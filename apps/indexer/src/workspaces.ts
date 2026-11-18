import { rm, lstat, realpath, rmdir } from "node:fs/promises";
import path from "node:path";

import type { IndexPreparation } from "@razbor/contracts";
import { workspaceState, assertRepositoryActive } from "@razbor/database";
import { deleteEmbeddingIndex } from "@razbor/database/embeddings";
import { errorDetails, logger } from "@razbor/harness/logger";

import {
  daemonRuntimeDirectory,
  MemoryBackend,
  verifyExecutable,
} from "@indexer/src/backend.js";
import type { Embeddings } from "@indexer/src/embeddings.js";
import { SemanticIndex, semanticSearchTool } from "@indexer/src/semantic.js";
import { DocumentIndex, documentSearchTool } from "@indexer/src/documents.js";
import { OwnedWorkspace } from "@indexer/src/review-source.js";
import { WorkspaceDivergedError } from "@indexer/src/source.js";

/** Persistent branch checkout with its own graph and optional semantic and document indexes. */
export class IndexWorkspace extends OwnedWorkspace {
  readonly temporary = false;
  private backend?: MemoryBackend;
  private backendInitialized = false;
  private readyHead?: string;
  private semantic?: SemanticIndex;
  private documents?: DocumentIndex;

  /** Retirement permanently cancels this handle, even when durable cleanup must be retried. */
  get retired() {
    return this.stop.signal.aborted;
  }

  /** Resolve the configured graph module for operations requiring a persistent index. */
  private get memory() {
    if (!this.config.memory)
      throw new Error("Codebase Memory is not installed");
    return this.config.memory;
  }

  /** Attach retrieval clients only when an enabled repository requests preparation. */
  private bindEmbeddings(embeddings?: Embeddings) {
    if (embeddings && !this.semantic) {
      this.semantic = new SemanticIndex(
        this.database,
        {
          owner: this.config.service.owner,
          workspaceId: this.id,
          repositoryId: this.repositoryId,
        },
        this.config,
        embeddings,
        this.memory.mode,
      );
      this.documents = new DocumentIndex(
        this.database,
        {
          owner: this.config.service.owner,
          workspaceId: this.id,
          repositoryId: this.repositoryId,
        },
        this.config,
        embeddings,
      );
    }
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

  /** Stop a known local backend without reading the registry or deleting the checkout during failed shutdown. */
  stopBackend() {
    this.cancel();
    return this.serial(() => this.closeBackend());
  }

  /**
   * Recover the previous service's workspace-specific daemon before reusing or deleting its files.
   * A source-only installation can retire an empty runtime, or preserve an ambiguous one for inspection.
   */
  private async recoverDaemon(retainWorkspace = false) {
    if (this.backendInitialized) return;
    if (this.backend) {
      await this.closeBackend();
      return;
    }
    const state = path.join(this.root, "state");
    const runtime = daemonRuntimeDirectory(state);
    const stat = await lstat(runtime).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat) return;
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o022) !== 0 ||
      (await realpath(runtime)) !== runtime
    )
      throw new Error(
        `Invalid daemon runtime ownership at ${runtime}. Verify the workspace-specific directory before retrying.`,
      );

    // Under the service storage lock an empty private namespace has no CBM
    // listener or lifetime-lock files. rmdir atomically refuses any contents.
    try {
      await rmdir(runtime);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
    const memory = this.config.memory;
    let verificationError: unknown;
    const verified =
      memory &&
      (await verifyExecutable(memory.executable).then(
        () => true,
        (error: unknown) => {
          verificationError = error;
          return false;
        },
      ));
    if (!verified) {
      const message = `Retained daemon state at ${runtime}. Stop the previous index service, verify its workspace daemon has exited, then remove only this runtime directory and retry cleanup.`;
      if (!retainWorkspace)
        throw new Error(message, { cause: verificationError });
      logger.warn({ workspaceId: this.id }, message);
      return;
    }
    this.backend = new MemoryBackend(
      memory,
      this.source.repository,
      state,
      this.id,
      false,
    );
    await this.closeBackend();
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
    embeddings: Embeddings | undefined,
    reuseReady = false,
    reportProgress?: (progress: Partial<IndexPreparation>) => void,
  ) {
    return this.serial(async () => {
      await this.validateStorage(true);
      this.bindEmbeddings(embeddings);
      const timeoutMs = Math.min(
        3600000,
        this.config.service.sync_ms +
          this.memory.index_ms +
          this.memory.startup_ms +
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
        this.policy,
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
      let phaseTimeoutMs: number | undefined = this.memory.index_ms;
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
        await this.recoverDaemon();
        const previousIndex = await this.backend?.waitForIndex(active);
        updatePhase("source_sync", this.config.service.sync_ms);
        const head = await this.refreshSource(active);
        let indexedAt: Date;
        if (!this.backend) {
          updatePhase(
            "graph_bootstrap",
            this.memory.startup_ms + this.memory.index_ms,
          );
          this.backendInitialized = true;
          this.backend = new MemoryBackend(
            this.memory,
            this.source.repository,
            path.join(this.root, "state"),
            this.id,
            true,
          );
          indexedAt = await this.backend.start(active);
        } else {
          updatePhase("graph_readiness", this.memory.index_ms);
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
        this.memory.tool_output_bytes,
      );
    }
    if (name === "semantic_search") {
      if (!this.semantic) throw new Error("semantic search is disabled");
      return this.semantic.search(
        head,
        input,
        signal,
        this.memory.tool_output_bytes,
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
   * activity, Git policy and any review-pinned revision before granting backend access.
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
      await this.validateStorage();
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
        this.policy,
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
      const result = await operation(this.backend, this.readyHead, active);
      await assertRepositoryActive(
        this.database,
        this.config.service.owner,
        this.repositoryId,
        this.policy,
      );
      active.throwIfAborted();
      return result;
    });
  }

  /**
   * Cancel and serialize teardown, stop the backend before removing source, and either
   * delete index/storage state or mark a retained workspace unready.
   */
  async close(deleting = false) {
    this.cancel();
    await this.serial(async () => {
      await this.validateStorage();
      this.readyHead = undefined;
      this.semantic?.reset();
      this.documents?.reset();
      await this.recoverDaemon(!deleting);
      await this.closeBackend();
      if (deleting)
        await deleteEmbeddingIndex(
          this.database,
          this.config.service.owner,
          this.id,
        );
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
