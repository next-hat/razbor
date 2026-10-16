import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  ensureDevelopmentWorkspaces,
  ownedWorkspaces,
  createReviewWorkspace,
  startWorkspaceDeletion,
  workspaceState,
  assertRepositoryActive,
  recoverRepositoryIndexSetup,
  pendingRepositoryIndexes,
  repositoryIndexSetup,
  type Database,
} from "@razbor/database";
import {
  reviewRequestSchema,
  publicIdSchema,
  indexPreparationStatusRequestSchema,
  indexPreparationSnapshotsSchema,
  type IndexPreparation,
  type IndexPreparationSnapshot,
} from "@razbor/contracts";
import { errorDetails, logger } from "@razbor/harness/logger";
import { embeddingStorageReady } from "@razbor/database/embeddings";

import { verifyExecutable } from "@indexer/src/backend.js";
import type { IndexerConfig } from "@indexer/src/config.js";
import { IndexWorkspace, prepareDataRoot } from "@indexer/src/workspaces.js";
import { Tokens, type AccessGrant } from "@indexer/src/tokens.js";
import { SynchronizationError } from "@indexer/src/source.js";
import { Embeddings } from "@indexer/src/embeddings.js";

const leaseSchema = reviewRequestSchema
  .extend({
    attemptId: publicIdSchema("attempt"),
    reviewId: publicIdSchema("review"),
    ttlMs: z.number().int().min(1000).max(3600000),
  })
  .strict();

const projectPageSchema = z
  .object({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

const listProjectsTool = {
  name: "list_projects",
  description:
    "List the projects authorized by this key, including projects awaiting indexing. Use each project ID when calling the other tools. Follow next_offset when has_more is true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    additionalProperties: false,
  },
};

/** Read an uncompressed HTTP body with a 64 KiB cap before JSON or MCP parsing. */
async function body(request: IncomingMessage) {
  if (request.headers["content-encoding"])
    throw new Error("encoded bodies are not supported");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error("request exceeds 64 KB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Send a JSON response with caching disabled for management and authorization results. */
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export class IndexService {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private readonly workspaces = new Map<string, IndexWorkspace>();
  private readonly tokens: Tokens;
  private readonly stop = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private reaper?: ReturnType<typeof setInterval>;
  private guard?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private readonly cleanupPending = new Set<string>();
  private readonly attempts = new Map<string, string>();

  // Review workspace records remain the durable token/attempt boundary. They
  // lease a shared index revision. Their PR checkout supplies the runner's
  // pinned Git objects but never gets its own graph or semantic index.
  private readonly reviewIndexes = new Map<
    string,
    {
      workspace: IndexWorkspace;
      headSha: string;
      baseSha: string;
      reviewHeadSha: string;
    }
  >();
  private reaping = false;
  private readonly removals = new Map<string, Promise<void>>();
  private embeddings?: Embeddings;
  private readonly preparations = new Map<
    string,
    {
      promise: Promise<{ headSha: string; project: string }>;
      workspace?: IndexWorkspace;
    }
  >();
  private readonly preparationProgress = new Map<string, IndexPreparation>();

  /**
   * Bind token authorization to the configured owner and apply conservative HTTP request and
   * header limits.
   */
  constructor(
    readonly config: IndexerConfig,
    admin: string,
    private readonly database: Database,
  ) {
    this.tokens = new Tokens(database, config.service.owner, admin);
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    this.server.maxHeadersCount = 40;
  }

  /**
   * Verify prerequisites, lock service storage, recover durable workspace state, start HTTP
   * handling, and schedule token/deletion/index lifecycle maintenance.
   */
  async listen() {
    await verifyExecutable(this.config.memory.executable);
    this.stop.signal.throwIfAborted();
    await prepareDataRoot(this.config);
    this.stop.signal.throwIfAborted();
    this.guard = spawn(
      "flock",
      [
        "--nonblock",
        path.join(this.config.service.data_root, "service.lock"),
        process.execPath,
        "-e",
        String.raw`process.stdout.write("ready\n"); process.stdin.resume();`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.guard.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      this.guard!.once("error", reject);
      this.guard!.once("exit", () =>
        reject(new Error("index storage already active or flock unavailable")),
      );
      this.guard!.stdout.once("data", () => resolve());
    });
    this.guard.once("exit", () => {
      if (!this.stop.signal.aborted)
        void this.close().catch(() =>
          logger.error("index shutdown cleanup failed"),
        );
    });
    try {
      await this.database.ready();
      if (this.config.embeddings) {
        await embeddingStorageReady(this.database);
        this.embeddings = await Embeddings.create(this.config.embeddings);
        await this.embeddings.ready(this.stop.signal);
        await this.embeddings.readyDocuments(this.stop.signal);
      }
      await recoverRepositoryIndexSetup(
        this.database,
        this.config.service.owner,
      );
      await ensureDevelopmentWorkspaces(
        this.database,
        this.config.service.owner,
        this.config.service.data_root,
      );
      for (const w of await ownedWorkspaces(
        this.database,
        this.config.service.owner,
      )) {
        const parent = path.join(
          this.config.service.data_root,
          w.temporary ? "reviews" : "development",
        );
        if (path.dirname(w.root) !== parent)
          throw new Error("workspace storage ownership mismatch");
        this.workspaces.set(
          w.id,
          new IndexWorkspace(
            w.id,
            w.root,
            w.repositoryId,
            this.config,
            w.temporary,
            w.git,
            this.database,
            this.embeddings,
          ),
        );
        if (w.attemptId) this.attempts.set(w.attemptId, w.id);
        if (
          w.temporary ||
          w.repositoryStatus === "deleting" ||
          w.state === "deleting"
        )
          await this.removeWorkspace(w.id).catch(() =>
            logger.warn({ workspaceId: w.id }, "workspace cleanup will retry"),
          );
        else
          await workspaceState(
            this.database,
            this.config.service.owner,
            w.id,
            "unready",
          );
      }
      this.stop.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(
          this.config.service.port,
          this.config.service.host,
          resolve,
        );
      });
      this.reaper = setInterval(() => {
        if (!this.reaping) {
          this.reaping = true;
          this.track(this.reap())
            .catch(() => logger.error("index lifecycle refresh unavailable"))
            .finally(() => {
              this.reaping = false;
            });
        }
      }, 1000).unref();
      const address = this.server.address();
      if (!address || typeof address === "string")
        throw new Error("index service did not bind a TCP port");
      logger.info({ port: address.port }, "index service listening");
      return address.port;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Register in-flight work for shutdown and remove it when settled without masking the
   * caller’s result.
   */
  private track<T>(operation: Promise<T>) {
    this.operations.add(operation);
    void operation
      .finally(() => this.operations.delete(operation))
      .catch(() => {});
    return operation;
  }

  /**
   * Load or create the active repository’s shared workspace, replacing its backend when the
   * durable Git policy changes.
   */
  private async developmentWorkspace(repositoryId: string) {
    await assertRepositoryActive(
      this.database,
      this.config.service.owner,
      repositoryId,
    );
    await ensureDevelopmentWorkspaces(
      this.database,
      this.config.service.owner,
      this.config.service.data_root,
      repositoryId,
    );
    const saved = (
      await ownedWorkspaces(this.database, this.config.service.owner)
    ).find((w) => !w.temporary && w.repositoryId === repositoryId);
    if (!saved || !["ready", "unready"].includes(saved.state))
      throw new Error("persistent workspace unavailable");
    if (
      path.dirname(saved.root) !==
      path.join(this.config.service.data_root, "development")
    )
      throw new Error("workspace storage ownership mismatch");
    let workspace = this.workspaces.get(saved.id);
    if (workspace && !isDeepStrictEqual(workspace.policy, saved.git)) {
      await workspace.close();
      this.workspaces.delete(saved.id);
      this.preparationProgress.delete(repositoryId);
      workspace = undefined;
    }
    if (!workspace) {
      workspace = new IndexWorkspace(
        saved.id,
        saved.root,
        saved.repositoryId,
        this.config,
        false,
        saved.git,
        this.database,
        this.embeddings,
      );
      this.workspaces.set(saved.id, workspace);
    }
    return workspace;
  }

  /**
   * Revalidate grants, schedule expired or deleting workspace cleanup without blocking
   * subsequent discovery, and advance pending repository setup.
   */
  private async reap() {
    await this.tokens.poll();
    for (const w of await ownedWorkspaces(
      this.database,
      this.config.service.owner,
    )) {
      if (
        w.state !== "deleting" &&
        w.repositoryStatus !== "deleting" &&
        !(
          w.temporary &&
          w.expiresAt !== undefined &&
          w.expiresAt <= Date.now()
        ) &&
        !this.cleanupPending.has(w.id)
      )
        continue;
      if (!this.workspaces.has(w.id)) {
        const parent = path.join(
          this.config.service.data_root,
          w.temporary ? "reviews" : "development",
        );
        if (path.dirname(w.root) !== parent)
          throw new Error("workspace storage ownership mismatch");
        this.workspaces.set(
          w.id,
          new IndexWorkspace(
            w.id,
            w.root,
            w.repositoryId,
            this.config,
            w.temporary,
            w.git,
            this.database,
            this.embeddings,
          ),
        );
      }
      // Cleanup cancels preparation before it waits for the workspace operation.
      // Keep the reaper available to discover further deletions while it runs.
      if (!this.removals.has(w.id))
        void this.track(this.removeWorkspace(w.id)).catch(() =>
          logger.warn({ workspaceId: w.id }, "workspace cleanup will retry"),
        );
    }
    await this.preparePendingRepository();
  }

  /**
   * Start at most one automatic initial repository index when no preparation is already
   * running.
   */
  private async preparePendingRepository() {
    // Bound automatic initial indexing to one repository at a time.
    if (!this.preparations.size && !this.stop.signal.aborted) {
      const [repository] = await pendingRepositoryIndexes(
        this.database,
        this.config.service.owner,
      );
      if (repository)
        void this.track(
          this.prepareRepository(repository.id, this.stop.signal),
        ).catch((error: unknown) =>
          logger.warn(
            {
              repositoryId: repository.id,
              cancelled: this.stop.signal.aborted,
              error: errorDetails(error),
            },
            "repository indexing requires retry",
          ),
        );
    }
  }

  /**
   * Wait for a shared preparation while allowing one caller to leave without cancelling
   * indexing owned by the service lifecycle.
   */
  private waitForPreparation<T>(operation: Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      /** Stop only this waiter when its request or authorization expires. */
      const cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      void operation.then(
        (result) => {
          signal.removeEventListener("abort", cancel);
          if (signal.aborted) reject(signal.reason);
          else resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }

  /**
   * Deduplicate service-owned preparation by repository, persist setup progress, and
   * publish safe terminal state only after preparation and cleanup settle.
   */
  private prepareRepository(
    repositoryId: string,
    signal: AbortSignal,
    reuseReady = false,
  ): Promise<{ headSha: string; project: string }> {
    signal.throwIfAborted();
    const pending = this.preparations.get(repositoryId);
    if (pending) {
      if (
        pending.workspace &&
        this.workspaces.get(pending.workspace.id) !== pending.workspace
      )
        // Replacement closes only workspace work; the old setup persistence may
        // still be settling. Start current-policy work after that job releases its slot.
        return this.waitForPreparation(
          pending.promise.catch(() => {}),
          signal,
        ).then(() => this.prepareRepository(repositoryId, signal, reuseReady));
      return this.waitForPreparation(pending.promise, signal);
    }
    const startedAt = new Date().toISOString();
    this.preparationProgress.set(repositoryId, {
      state: "queued",
      phase: "queued",
      startedAt,
      updatedAt: startedAt,
      code: { processed: 0 },
      documents: { processed: 0 },
    });
    /** Update only bounded operational metadata for the current shared preparation. */
    const reportProgress = (progress: Partial<IndexPreparation>) => {
      if (
        this.preparations.get(repositoryId) !== entry ||
        (entry.workspace &&
          this.workspaces.get(entry.workspace.id) !== entry.workspace)
      )
        return;
      const current = this.preparationProgress.get(repositoryId);
      if (current)
        this.preparationProgress.set(repositoryId, {
          ...current,
          ...progress,
          updatedAt: new Date().toISOString(),
        });
    };
    const preparation = Promise.resolve()
      .then(async () => {
        let workspace: IndexWorkspace | undefined;
        try {
          this.stop.signal.throwIfAborted();
          if (
            !(await repositoryIndexSetup(
              this.database,
              this.config.service.owner,
              repositoryId,
              "indexing",
            ))
          )
            throw new Error("repository unavailable");
          workspace = await this.developmentWorkspace(repositoryId);
          entry.workspace = workspace;
          // Policy replacement discards old metadata; this job starts a fresh snapshot.
          if (!this.preparationProgress.has(repositoryId))
            this.preparationProgress.set(repositoryId, {
              state: "queued",
              phase: "queued",
              startedAt,
              updatedAt: new Date().toISOString(),
              code: { processed: 0 },
              documents: { processed: 0 },
            });
          const binding = await workspace.prepare(
            this.stop.signal,
            reuseReady,
            reportProgress,
          );
          this.stop.signal.throwIfAborted();
          if (
            !(await repositoryIndexSetup(
              this.database,
              this.config.service.owner,
              repositoryId,
              "ready",
              undefined,
              workspace.policy,
            ))
          )
            throw new Error("repository unavailable");
          reportProgress({
            state: "ready",
            phase: "ready",
            finishedAt: new Date().toISOString(),
          });
          return binding;
        } catch (error) {
          try {
            await repositoryIndexSetup(
              this.database,
              this.config.service.owner,
              repositoryId,
              this.stop.signal.aborted ? "pending" : "error",
              error instanceof SynchronizationError
                ? error.message
                : "Indexing failed. Verify repository access and retry setup.",
              workspace?.policy,
            );
          } catch (setupError) {
            logger.warn(
              { repositoryId, error: errorDetails(setupError) },
              "repository indexing state unavailable",
            );
          }
          reportProgress({
            state: "error",
            phase: "error",
            finishedAt: new Date().toISOString(),
            errorCode:
              this.preparationProgress.get(repositoryId)?.errorCode ??
              (this.stop.signal.aborted ||
              (error instanceof Error && error.name === "AbortError")
                ? "cancelled"
                : (error instanceof Error && error.name === "TimeoutError") ||
                    (typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      error.code === "REQUEST_TIMEOUT")
                  ? "timeout"
                  : "failed"),
          });
          throw error;
        }
      })
      .finally(() => this.preparations.delete(repositoryId));
    const entry: {
      promise: typeof preparation;
      workspace?: IndexWorkspace;
    } = { promise: preparation };
    this.preparations.set(repositoryId, entry);
    this.track(preparation);
    return this.waitForPreparation(preparation, signal);
  }

  /**
   * Deduplicate workspace deletion, revoke its access before serialized cleanup, and remove
   * in-memory bindings only after durable deletion succeeds.
   */
  private removeWorkspace(id: string): Promise<void> {
    const pending = this.removals.get(id);
    if (pending) return pending;
    const workspace = this.workspaces.get(id);
    if (!workspace) return Promise.resolve();
    this.cleanupPending.add(id);
    const removal = (async () => {
      await startWorkspaceDeletion(
        this.database,
        this.config.service.owner,
        id,
      );
      this.tokens.cancelWorkspace(id);
      workspace.cancel();
      await workspace.close(true);
      await workspaceState(
        this.database,
        this.config.service.owner,
        id,
        "deleted",
      );
      this.workspaces.delete(id);
      if (!workspace.temporary)
        this.preparationProgress.delete(workspace.repositoryId);
      this.reviewIndexes.delete(id);
      this.cleanupPending.delete(id);
      for (const [attempt, workspaceId] of this.attempts)
        if (workspaceId === id) this.attempts.delete(attempt);
    })().finally(() => this.removals.delete(id));
    this.removals.set(id, removal);
    return removal;
  }

  /**
   * Tie each request to disconnect and service cancellation, track its lifetime, and return
   * only safe validation or synchronization diagnostics.
   */
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const abort = new AbortController();
    /** Cancel request work when the client aborts or its response connection closes. */
    const cancel = () => abort.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    const signal = AbortSignal.any([abort.signal, this.stop.signal]);
    try {
      await this.track(this.route(request, response, signal));
    } catch (error) {
      logger.warn(
        {
          cancelled: signal.aborted,
          // SynchronizationError contains operator-safe messages, never raw Git output.
          reason:
            error instanceof SynchronizationError ? error.message : undefined,
          error: errorDetails(error),
        },
        "index request failed",
      );
      if (!response.headersSent && !response.destroyed)
        json(response, error instanceof z.ZodError ? 400 : 503, {
          error:
            error instanceof SynchronizationError
              ? error.message
              : "index operation failed or workspace is not ready",
        });
      else response.destroy();
    } finally {
      request.off("aborted", cancel);
      response.off("close", cancel);
    }
  }

  /**
   * Discover tool schemas from a ready authorized project while keeping project discovery
   * available when sibling indexes are unready.
   */
  private async projectTools(token: string, signal: AbortSignal) {
    const grant = await this.tokens.authorize(token);
    let available: ReturnType<IndexWorkspace["tools"]> = [];
    // Tool schemas are shared across projects. An unready project must not hide
    // the schemas of a ready sibling, or prevent authorized project discovery.
    for (const scope of grant.scopes) {
      signal.throwIfAborted();
      const workspace = this.workspaces.get(scope.workspace);
      if (!workspace || workspace.temporary) continue;
      try {
        available = await workspace.access(signal, async (backend) => {
          await this.tokens.authorizeWorkspace(
            token,
            scope.workspace,
            workspace.repositoryId,
          );
          return workspace.tools(backend);
        });
        break;
      } catch {
        signal.throwIfAborted();
      }
    }
    await this.tokens.authorize(token);
    signal.throwIfAborted();
    return {
      tools: [
        listProjectsTool,
        ...available.map((tool) => ({
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...tool.inputSchema.properties,
              project: {
                type: "string",
                description:
                  "An authorized project ID returned by list_projects.",
                pattern: "^idx_[A-Za-z0-9]{16}$",
              },
            },
            required: [...(tool.inputSchema.required ?? []), "project"],
            additionalProperties: false,
          },
        })),
      ],
    };
  }

  /**
   * Return a stable, bounded page of currently authorized projects, advancing pagination
   * only past entries actually included.
   */
  private async projects(token: string, input: unknown, signal: AbortSignal) {
    const { offset, limit } = projectPageSchema.parse(input);
    const current = await this.tokens.authorize(token);
    signal.throwIfAborted();
    const scopes = [...current.scopes].sort((a, b) =>
      a.workspace.localeCompare(b.workspace),
    );
    const projects = scopes.slice(offset, offset + limit).map((scope) => ({
      project: scope.workspace,
      repository: scope.repository,
      name:
        scope.name.length > 128 ? `${scope.name.slice(0, 128)}…` : scope.name,
    }));
    // Keep JSON intact at the configured byte limit; the next page starts after
    // the entries actually returned, including when the requested page shrinks.
    while (true) {
      const next = offset + projects.length;
      const text = JSON.stringify({
        projects,
        total: scopes.length,
        has_more: next < scopes.length,
        ...(next < scopes.length ? { next_offset: next } : {}),
      });
      if (Buffer.byteLength(text) <= this.config.memory.tool_output_bytes)
        return text;
      if (projects.length <= 1)
        throw new Error("project list entry exceeds output limit");
      projects.pop();
    }
  }

  /**
   * Require non-browser bearer access, separate management operations from grants, and bind
   * source/MCP requests to their authorized workspace and attempt.
   */
  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) {
    if (request.headers.origin) {
      json(response, 403, { error: "browser origins are not accepted" });
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      json(response, 401, { error: "bearer token required" });
      return;
    }
    const token = authorization.slice(7);
    const admin = this.tokens.isAdmin(token);
    let grant;
    if (!admin) {
      try {
        grant = await this.tokens.authorize(token);
      } catch {
        json(response, 401, { error: "invalid, expired or revoked token" });
        return;
      }
    }
    // This origin only parses relative URLs; it never opens a network connection.
    const url = new URL(request.url ?? "/", "http://indexer");
    if (url.search) {
      json(response, 400, { error: "query parameters are not supported" });
      return;
    }
    if (
      admin &&
      (await this.routeAdministration(request, response, url, signal))
    )
      return;
    const source = /^\/reviews\/(att_[A-Za-z0-9]{16})\/source$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && source && grant) {
      const id = this.attempts.get(source[1]);
      const workspace = id ? this.workspaces.get(id) : undefined;
      const pinned = id ? this.reviewIndexes.get(id) : undefined;
      if (
        !workspace ||
        !pinned ||
        !workspace.temporary ||
        grant.workspace !== id
      )
        throw new Error("source access does not match attempt");
      const activeGrant = await this.tokens.authorizeWorkspace(
        token,
        workspace.id,
        workspace.repositoryId,
      );
      await workspace.streamReviewSource(
        response,
        {
          baseSha: pinned.baseSha,
          headSha: pinned.reviewHeadSha,
        },
        AbortSignal.any([signal, activeGrant.stop.signal]),
      );
      return;
    }
    const refresh = /^\/workspaces\/(idx_[A-Za-z0-9]{16})\/refresh$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && refresh) {
      await this.refreshWorkspace(
        refresh[1],
        response,
        signal,
        token,
        admin,
        grant,
      );
      return;
    }
    if (url.pathname === "/mcp" && grant) {
      await this.serveMcp(request, response, url, signal, token, grant);
      return;
    }
    json(response, 403, { error: "operation not permitted" });
  }

  /**
   * Dispatch authenticated management health, repository preparation, review creation, and
   * revocation routes; report whether a route was handled.
   */
  private async routeAdministration(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    signal: AbortSignal,
  ) {
    if (request.method === "GET" && url.pathname === "/health") {
      await this.database.ready();
      json(response, 200, { status: "ready" });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/index-progress") {
      const { repositoryIds } = indexPreparationStatusRequestSchema.parse(
        JSON.parse(await body(request)),
      );
      const requested = new Set(repositoryIds);
      const snapshots: IndexPreparationSnapshot[] = [];
      for (const workspace of await ownedWorkspaces(
        this.database,
        this.config.service.owner,
      )) {
        if (
          !requested.has(workspace.repositoryId) ||
          workspace.temporary ||
          workspace.repositoryStatus !== "active" ||
          !["ready", "unready"].includes(workspace.state)
        )
          continue;
        snapshots.push({
          repositoryId: workspace.repositoryId,
          workspaceId: workspace.id,
          preparation: isDeepStrictEqual(
            this.workspaces.get(workspace.id)?.policy,
            workspace.git,
          )
            ? (this.preparationProgress.get(workspace.repositoryId) ?? null)
            : null,
        });
        requested.delete(workspace.repositoryId);
      }
      signal.throwIfAborted();
      json(response, 200, indexPreparationSnapshotsSchema.parse(snapshots));
      return true;
    }
    const repository = /^\/repositories\/(repo_[A-Za-z0-9]{16})\/index$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && repository) {
      const input = z
        .object({
          prepare: z.boolean(),
          background: z.boolean().optional().default(false),
        })
        .strict()
        .refine((value) => !value.background || value.prepare, {
          path: ["background"],
          message: "background indexing requires preparation",
        })
        .parse(JSON.parse(await body(request)));
      signal.throwIfAborted();
      const workspace = await this.developmentWorkspace(repository[1]);
      signal.throwIfAborted();
      if (input.background) {
        void this.prepareRepository(repository[1], this.stop.signal).catch(
          (error: unknown) =>
            logger.warn(
              { repositoryId: repository[1], error: errorDetails(error) },
              "background repository indexing requires retry",
            ),
        );
        json(response, 202, { workspaceId: workspace.id });
        return true;
      }
      const binding = input.prepare
        ? await this.prepareRepository(repository[1], signal)
        : {};
      json(response, 200, { workspaceId: workspace.id, ...binding });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/reviews") {
      await this.createReview(request, response, signal);
      return true;
    }
    const review = /^\/reviews\/(att_[A-Za-z0-9]{16})$/.exec(url.pathname);
    if (request.method === "DELETE" && review) {
      const workspaceId = this.attempts.get(review[1]);
      if (workspaceId) await this.removeWorkspace(workspaceId);
      json(response, 200, { revoked: true });
      return true;
    }
    const tokenId = /^\/tokens\/(tok_[A-Za-z0-9]{16})$/.exec(url.pathname);
    if (request.method === "DELETE" && tokenId) {
      await this.tokens.revoke(tokenId[1]);
      json(response, 200, { revoked: true });
      return true;
    }
    return false;
  }

  /**
   * Allocate an expiring attempt checkout, pin its source commits and shared index revision,
   * and issue scoped access; remove the workspace if preparation fails.
   */
  private async createReview(
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) {
    const lease = leaseSchema.parse(JSON.parse(await body(request)));
    if (
      this.attempts.has(lease.attemptId) ||
      [...this.workspaces.values()].filter((w) => w.temporary).length >=
        this.config.service.max_reviews
    ) {
      json(response, 409, {
        error: "attempt exists or review capacity reached",
      });
      return;
    }
    const saved = await createReviewWorkspace(
      this.database,
      this.config.service.owner,
      this.config.service.data_root,
      lease,
    );
    const id = saved.id;
    const workspace = new IndexWorkspace(
      id,
      saved.root,
      lease.repositoryId,
      this.config,
      true,
      saved.git,
      this.database,
      this.embeddings,
    );
    this.workspaces.set(id, workspace);
    this.attempts.set(lease.attemptId, id);
    const started = performance.now();
    let phase = "shared_index";
    try {
      const shared = await this.developmentWorkspace(lease.repositoryId);
      const binding = await this.prepareRepository(
        lease.repositoryId,
        signal,
        true,
      );
      // Git credentials stay indexer-side. The runner snapshots this exact PR
      // checkout, while all graph/semantic queries use the shared branch index.
      phase = "review_source";
      await workspace.prepareReviewSource(signal, lease);
      phase = "review_access";
      const access = await shared.access(
        signal,
        async (_backend, head, active) => {
          await workspaceState(
            this.database,
            this.config.service.owner,
            id,
            "ready",
            lease.headSha,
            undefined,
            head,
          );
          active.throwIfAborted();
          const access = await this.tokens.issue(id, lease.ttlMs);
          this.reviewIndexes.set(id, {
            workspace: shared,
            headSha: head,
            baseSha: lease.baseSha,
            reviewHeadSha: lease.headSha,
          });
          active.throwIfAborted();
          return access;
        },
        binding.headSha,
      );
      logger.info(
        {
          reviewId: lease.reviewId,
          attemptId: lease.attemptId,
          headSha: lease.headSha,
          indexHeadSha: binding.headSha,
          project: shared.id,
          expiresAt: access.expiresAt,
        },
        "review MCP access issued",
      );
      json(response, 201, {
        project: binding.project,
        headSha: lease.headSha,
        indexHeadSha: binding.headSha,
        indexBranch: shared.branch,
        ...access,
        attemptId: lease.attemptId,
      });
    } catch (error) {
      // Cleanup must not erase the preparation failure or its attempt context.
      logger.warn(
        {
          reviewId: lease.reviewId,
          attemptId: lease.attemptId,
          repositoryId: lease.repositoryId,
          workspaceId: id,
          phase,
          durationMs: Math.round(performance.now() - started),
          cancelled: signal.aborted,
          error: errorDetails(error),
        },
        "review source preparation failed",
      );
      await this.removeWorkspace(id);
      throw error;
    }
  }

  /**
   * Require management or scoped refresh permission, prepare the persistent repository
   * index, and revalidate grant access before returning the new binding.
   */
  private async refreshWorkspace(
    workspaceId: string,
    response: ServerResponse,
    signal: AbortSignal,
    token: string,
    admin: boolean,
    grant?: AccessGrant,
  ) {
    if (
      !admin &&
      !(
        grant?.refresh &&
        grant.scopes.some((scope) => scope.workspace === workspaceId)
      )
    ) {
      json(response, 403, { error: "refresh permission required" });
      return;
    }
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.temporary) {
      json(response, 404, { error: "unknown repository ID" });
      return;
    }
    const active = grant
      ? AbortSignal.any([
          signal,
          grant.stop.signal,
          ...(grant.expiresAt
            ? [AbortSignal.timeout(Math.max(1, grant.expiresAt - Date.now()))]
            : []),
        ])
      : signal;
    if (grant)
      await this.tokens.authorizeWorkspace(
        token,
        workspace.id,
        workspace.repositoryId,
      );
    const binding = await this.prepareRepository(
      workspace.repositoryId,
      active,
    );
    if (grant)
      await this.tokens.authorizeWorkspace(
        token,
        workspace.id,
        workspace.repositoryId,
      );
    active.throwIfAborted();
    json(response, 200, binding);
  }

  /**
   * Serve one bounded MCP exchange with per-call authorization and cancellation, preserving
   * review index pins and refusing results when grants or source readiness change.
   */
  private async serveMcp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    signal: AbortSignal,
    token: string,
    grant: AccessGrant,
  ) {
    const leased = this.reviewIndexes.get(grant.workspace);
    const workspace = leased?.workspace ?? this.workspaces.get(grant.workspace);
    if (!grant.multipleProjects && (!workspace || workspace.temporary)) {
      json(response, 503, { error: "workspace unavailable" });
      return;
    }
    const active = AbortSignal.any([
      signal,
      grant.stop.signal,
      ...(grant.expiresAt
        ? [AbortSignal.timeout(Math.max(1, grant.expiresAt - Date.now()))]
        : []),
    ]);
    const handler = createMcpHandler(
      () => {
        const server = new Server(
          { name: "razbor-indexer", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler("tools/list", async () => {
          if (grant.multipleProjects) return this.projectTools(token, active);
          await this.tokens.authorizeWorkspace(
            token,
            grant.workspace,
            workspace!.repositoryId,
          );
          return workspace!.access(
            active,
            async (backend, _head, callSignal) => {
              const tools = workspace!.tools(backend);
              await this.tokens.authorizeWorkspace(
                token,
                grant.workspace,
                workspace!.repositoryId,
              );
              callSignal.throwIfAborted();
              return { tools };
            },
            leased?.headSha,
          );
        });
        server.setRequestHandler("tools/call", async (request, context) => {
          let selectedWorkspace: IndexWorkspace | undefined;
          try {
            const callActive = AbortSignal.any([active, context.mcpReq.signal]);
            callActive.throwIfAborted();
            const input = request.params.arguments ?? {};
            if (
              grant.multipleProjects &&
              request.params.name === "list_projects"
            ) {
              const text = await this.projects(token, input, callActive);
              return { content: [{ type: "text" as const, text }] };
            }
            const project = grant.multipleProjects
              ? publicIdSchema("workspace").parse(input.project)
              : grant.workspace;
            const current = await this.tokens.authorize(token);
            const authorized = current.scopes.some(
              (item) => item.workspace === project,
            );
            if (!authorized)
              throw new Error("token does not authorize this workspace");
            const selectedLease = this.reviewIndexes.get(project);
            selectedWorkspace =
              selectedLease?.workspace ?? this.workspaces.get(project);
            const selected = selectedWorkspace;
            if (!selected || selected.temporary)
              throw new Error("workspace unavailable");
            await this.tokens.authorizeWorkspace(
              token,
              project,
              selected.repositoryId,
            );
            const args = { ...input };
            if (grant.multipleProjects) delete args.project;
            return await selected.access(
              callActive,
              async (backend, head, callSignal) => {
                await this.tokens.authorizeWorkspace(
                  token,
                  project,
                  selected.repositoryId,
                );
                callSignal.throwIfAborted();
                const text = await selected.query(
                  backend,
                  head,
                  request.params.name,
                  args,
                  callSignal,
                );
                await this.tokens.authorizeWorkspace(
                  token,
                  project,
                  selected.repositoryId,
                );
                callSignal.throwIfAborted();
                return { content: [{ type: "text" as const, text }] };
              },
              selectedLease?.headSha,
            );
          } catch {
            logger.warn(
              { workspaceId: selectedWorkspace?.id },
              "MCP query failed",
            );
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "MCP query failed, was cancelled, or the workspace is not ready. The shared index may have advanced beyond this review's pinned index revision. This is not an empty result; use the pinned review files and disclose unavailable graph evidence.",
                },
              ],
            };
          }
        });
        return server;
      },
      { maxSubscriptions: 0 },
    );
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const result = await handler.fetch(
        new Request(`http://indexer${url.pathname}`, {
          method: request.method,
          headers,
          body: request.method === "POST" ? await body(request) : undefined,
          signal: active,
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body)
        await pipeline(
          Readable.fromWeb(
            result.body as import("node:stream/web").ReadableStream,
          ),
          response,
          { signal: active },
        );
      else response.end();
    } finally {
      await handler.close();
    }
  }

  /**
   * Share one shutdown promise, cancel service work, await tracked operations, clean
   * temporary/deleting workspaces, and release the storage lock after teardown.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stop.abort();
      clearInterval(this.reaper);
      this.tokens.close();
      this.server.closeAllConnections();
      if (this.server.listening)
        await new Promise<void>((resolve) =>
          this.server.close(() => resolve()),
        );
      await Promise.allSettled(this.operations);
      const deleting = new Set(
        (await ownedWorkspaces(this.database, this.config.service.owner))
          .filter(
            (workspace) =>
              workspace.state === "deleting" ||
              workspace.repositoryStatus === "deleting",
          )
          .map((workspace) => workspace.id),
      );
      const results = await Promise.allSettled(
        [...this.workspaces.values()].map((workspace) =>
          workspace.temporary || deleting.has(workspace.id)
            ? this.removeWorkspace(workspace.id)
            : workspace.close(),
        ),
      );
      this.guard?.stdin.end();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("index workspace cleanup failed");
    })();
    return this.closing;
  }
}
