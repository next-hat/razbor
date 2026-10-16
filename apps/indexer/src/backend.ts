import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, lstat, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

import { BoundTools, discoverTools, resultText } from "@razbor/harness/mcp";
import { boundedOutput } from "@razbor/harness/capability-files";
import { git, gitEnvironment } from "@razbor/harness/git";
import { errorDetails, logger } from "@razbor/harness/logger";

import type { CodeSymbol } from "@indexer/src/semantic-chunks.js";

const exec = promisify(execFile);

export const releaseVersion = "0.11.0";

export const binarySha256 =
  "ce11c141431aeadd788506c3a7e6942db8fd438dec369d0707a39ec9fd8c6510";

export type BackendConfig = {
  executable: string;
  mode?: "fast" | "moderate" | "full";
  startup_ms: number;
  index_ms: number;
  query_ms: number;
  tool_output_bytes: number;
};

/**
 * Require the supported platform and a regular CBM executable whose SHA-256 matches the
 * pinned portable release.
 */
export async function verifyExecutable(executable: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      "configured Codebase Memory portable bundle requires linux/amd64",
    );
  if (!(await lstat(executable)).isFile())
    throw new Error("Codebase Memory executable must be a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  if (hash.digest("hex") !== binarySha256)
    throw new Error(
      "Codebase Memory binary does not match the pinned v0.11.0 portable release; run the documented provisioning command",
    );
}

export class MemoryBackend {
  private readonly client = new Client({
    name: "razbor-indexer",
    version: "0.1.0",
  });
  private readonly stop = new AbortController();
  private readonly log;
  private readonly env: Record<string, string> & { NODE_ENV: "development" };
  private stderrBytes = 0;
  private stderr = Buffer.alloc(0);
  private upstreamProject?: string;
  bound?: BoundTools;

  /**
   * Create workspace-specific CBM environment and runtime paths without inheriting ambient
   * credentials or repository-local configuration.
   */
  constructor(
    private readonly config: BackendConfig,
    readonly repository: string,
    readonly state: string,
    public project: string,
    private readonly watch: boolean,
  ) {
    this.log = logger.child({ project });
    this.env = {
      ...gitEnvironment,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: state,
      TMPDIR: path.join(state, "tmp"),
      LOGNAME: "razbor",
      USER: "razbor",
      SHELL: "/bin/false",
      TERM: "dumb",
      XDG_CONFIG_HOME: path.join(state, "config"),
      CBM_CACHE_DIR: path.join(state, "cache"),
      // Keep AF_UNIX rendezvous paths below the kernel's short path limit.
      // The namespace is private to this exact service-owned state directory.
      CBM_RUNTIME_DIR: `/tmp/rdm-${createHash("sha256").update(state).digest("hex").slice(0, 20)}`,
      CBM_ALLOWED_ROOT: repository,
      CBM_WORKERS: "2",
      CBM_MEM_BUDGET_MB: "512",
      CBM_LOG_LEVEL: "none",
    };
  }

  /**
   * Create owned state directories, validate source and binary version, start MCP, bootstrap
   * indexing, and wait for authoritative ready metadata.
   */
  async start(signal: AbortSignal) {
    const started = performance.now();
    const timeoutMs = this.config.index_ms + this.config.startup_ms;
    const deadline = AbortSignal.timeout(timeoutMs);
    const initSignal = AbortSignal.any([signal, this.stop.signal, deadline]);
    for (const directory of [
      this.state,
      this.env.TMPDIR,
      this.env.CBM_CACHE_DIR,
      this.env.CBM_RUNTIME_DIR,
      this.env.XDG_CONFIG_HOME,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (
        (await realpath(directory)) !== directory ||
        (await lstat(directory)).uid !== process.getuid!()
      )
        throw new Error(
          "MCP state directories must be owned, canonical directories",
        );
    }
    await this.validateSource(initSignal);
    await writeFile(
      path.join(this.env.CBM_CACHE_DIR, "config.json"),
      JSON.stringify({ ui_enabled: false }),
    );
    const version = await this.command(["--version"], initSignal);
    if (!version.includes(releaseVersion))
      throw new Error("unexpected Codebase Memory version");
    for (const [key, value] of [
      // Bootstrap explicitly once; subsequent Git updates use the watcher.
      ["auto_index", "false"],
      ["auto_watch", String(this.watch)],
      ["watcher_enabled", String(this.watch)],
    ])
      await this.command(["config", "set", key, value], initSignal);
    const transport = new StdioClientTransport({
      command: this.config.executable,
      args: [],
      env: this.env,
      cwd: this.repository,
      stderr: "pipe",
      maxBufferSize: 4_000_000,
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      // Retain only a bounded tail for container diagnostics when startup fails.
      this.stderr = Buffer.concat([
        this.stderr,
        chunk.subarray(-8192),
      ]).subarray(-8192);
    });
    await this.client.connect(transport, {
      signal: initSignal,
      timeout: this.config.startup_ms,
    });
    if (this.client.getServerVersion()?.version !== releaseVersion)
      throw new Error("MCP initialization reported an unexpected version");
    const discovered = await discoverTools(
      this.client,
      initSignal,
      this.config.startup_ms,
    );
    this.log.info(
      {
        serverVersion: releaseVersion,
        durationMs: Math.round(performance.now() - started),
      },
      "MCP backend started",
    );
    const indexStart = performance.now();
    const indexed = JSON.parse(
      resultText(
        await this.client
          .callTool(
            {
              name: "index_repository",
              arguments: {
                repo_path: this.repository,
                mode: this.config.mode ?? "full",
                persistence: false,
              },
            },
            { signal: initSignal, timeout: this.config.index_ms },
          )
          .catch((error: unknown) => {
            // A retained tail may begin inside a credential; discard that partial line.
            const stderr = this.stderr.toString("utf8");
            this.log.warn(
              {
                phase: "graph_index",
                tool: "index_repository",
                timeoutMs: this.config.index_ms,
                preparationTimeoutMs: timeoutMs,
                durationMs: Math.round(performance.now() - indexStart),
                cancelled: signal.aborted || this.stop.signal.aborted,
                deadlineExceeded: deadline.aborted,
                error: errorDetails(error),
                backendStderr: errorDetails({
                  stderr:
                    this.stderrBytes > 8192
                      ? stderr.replace(/^[^\n]*\n?/, "[truncated]\n")
                      : stderr,
                }).stderr,
                stderrBytes: this.stderrBytes,
              },
              "MCP indexing failed",
            );
            throw error;
          }),
      ),
    );
    if (
      indexed.status !== "indexed" ||
      typeof indexed.project !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(indexed.project)
    )
      throw new Error("Codebase Memory indexing failed or is incomplete");
    this.upstreamProject = indexed.project;
    this.bound = new BoundTools(discovered, indexed.project);
    const indexedAt = await this.waitForIndex(initSignal);
    this.log.info(
      {
        durationMs: Math.round(performance.now() - indexStart),
        watching: this.watch,
        toolNames: this.bound.tools.map((tool) => tool.name),
      },
      "index prepared",
    );
    return indexedAt;
  }

  /**
   * Reject tracked symlinks and repository-local CBM state or configuration before indexing
   * or accepting watcher updates.
   */
  async validateSource(signal: AbortSignal) {
    // Apply the same boundary before bootstrap and after watched Git updates.
    const files = await git(this.repository, ["ls-files", "--stage"], signal);
    if (
      files
        .split("\n")
        .some(
          (line) =>
            line.startsWith("120000 ") ||
            /\t\.codebase-memory(?:\/|\.json$)/.test(line),
        )
    )
      throw new Error(
        "indexed repositories must not contain symlinks, .codebase-memory artifacts or .codebase-memory.json",
      );
    for (const name of [".codebase-memory", ".codebase-memory.json"]) {
      const exists = await lstat(path.join(this.repository, name)).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new Error(
          "repository-local Codebase Memory artifacts/configuration are not allowed",
        );
    }
  }

  /**
   * Require ready metadata for this exact checkout and, when requested, wait for a strictly
   * newer index publication timestamp.
   */
  async waitForIndex(signal: AbortSignal, after?: Date) {
    const active = AbortSignal.any([
      signal,
      this.stop.signal,
      AbortSignal.timeout(this.config.index_ms),
    ]);
    while (true) {
      active.throwIfAborted();
      const status = JSON.parse(
        await this.query("index_status", { format: "json" }, active, false),
      );
      const indexedAt = new Date(status.indexed_at);
      if (
        status.status !== "ready" ||
        status.root_path !== this.repository ||
        !Number.isFinite(indexedAt.getTime())
      )
        throw new Error("Codebase Memory index metadata is not ready");
      if (!after || indexedAt > after) return indexedAt;
      await delay(500, undefined, { signal: active });
    }
  }

  /**
   * Invoke an allowed project-bound MCP tool with cancellation and timeout limits,
   * translating private paths and bounding output for external callers.
   */
  async query(
    name: string,
    input: unknown,
    signal: AbortSignal,
    bounded = true,
  ) {
    if (!this.bound) throw new Error("MCP backend is not initialized");
    const started = performance.now();
    const text = resultText(
      await this.client.callTool(
        {
          name,
          arguments: this.bound.arguments(name, this.translateInput(input)),
        },
        {
          signal: AbortSignal.any([signal, this.stop.signal]),
          timeout: this.config.query_ms,
        },
      ),
    );
    this.log.info(
      {
        tool: name,
        durationMs: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(text),
      },
      "MCP query completed",
    );
    if (!bounded) return text;
    const external = text
      .replaceAll(this.repository, "/repository")
      .replaceAll(this.upstreamProject!, this.project);
    return boundedOutput(external, this.config.tool_output_bytes);
  }

  /**
   * Enumerate repository function and method symbols through validated paginated management
   * queries, rejecting incomplete cursor traversal.
   */
  async *symbols(signal: AbortSignal): AsyncGenerator<CodeSymbol> {
    if (!this.upstreamProject) throw new Error("MCP is not initialized");
    // Project graphs also contain external symbols (for example Python builtins).
    // Only enumerate repository symbols; the project name was validated at startup.
    // This management-only query is never model-supplied.
    const query =
      `MATCH (n:Function|Method) WHERE n.qualified_name STARTS WITH '${this.upstreamProject}.' ` +
      "RETURN n.qualified_name AS qualifiedName, n.file_path AS path, n.start_line AS startLine, n.end_line AS endLine ORDER BY qualifiedName";
    const schema = z.object({
      columns: z.tuple([
        z.literal("qualifiedName"),
        z.literal("path"),
        z.literal("startLine"),
        z.literal("endLine"),
      ]),
      rows: z.array(
        z.tuple([z.string().min(1), z.string().min(1), z.string(), z.string()]),
      ),
      has_more: z.boolean(),
      next_cursor: z.string().optional(),
      truncation_reason: z.string().optional(),
    });
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      signal.throwIfAborted();
      const response = schema.safeParse(
        JSON.parse(
          resultText(
            await this.client.callTool(
              {
                name: "query_graph",
                arguments: {
                  project: this.upstreamProject,
                  query,
                  format: "json",
                  max_rows: 200,
                  max_output_tokens: 65536,
                  ...(cursor ? { cursor } : {}),
                },
              },
              {
                signal: AbortSignal.any([signal, this.stop.signal]),
                timeout: this.config.query_ms,
              },
            ),
          ),
        ),
      );
      if (!response.success)
        throw new Error("invalid Codebase Memory symbol response");
      for (const [qualifiedName, file, start, end] of response.data.rows) {
        const startLine = Number(start),
          endLine = Number(end);
        if (
          !Number.isSafeInteger(startLine) ||
          !Number.isSafeInteger(endLine) ||
          startLine < 1 ||
          endLine < startLine
        )
          throw new Error("invalid Codebase Memory symbol range");
        yield {
          qualifiedName: this.publicSymbol(qualifiedName),
          path: file,
          startLine,
          endLine,
        };
      }
      if (!response.data.has_more) break;
      cursor = response.data.next_cursor;
      if (!cursor || !response.data.rows.length || cursors.has(cursor))
        throw new Error("Codebase Memory symbol enumeration is incomplete");
      cursors.add(cursor);
    } while (cursor);
  }

  /**
   * Replace the private CBM project prefix with the public workspace ID, rejecting symbols
   * from other projects.
   */
  publicSymbol(qualifiedName: string) {
    if (
      !this.upstreamProject ||
      !qualifiedName.startsWith(`${this.upstreamProject}.`)
    )
      throw new Error("symbol does not belong to the indexed project");
    return this.project + qualifiedName.slice(this.upstreamProject.length);
  }

  /**
   * Recursively map public project IDs and repository paths back to the private CBM
   * namespace before tool validation.
   */
  private translateInput(input: unknown): unknown {
    if (typeof input === "string")
      return input
        .replaceAll(this.project, this.upstreamProject!)
        .replaceAll("/repository", this.repository);
    if (Array.isArray(input))
      return input.map((item) => this.translateInput(item));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          this.translateInput(value),
        ]),
      );
    return input;
  }

  /**
   * Run the pinned CBM executable in the workspace-specific environment with bounded startup
   * time and output.
   */
  private async command(args: string[], signal?: AbortSignal) {
    return (
      await exec(this.config.executable, args, {
        env: this.env,
        cwd: this.repository,
        timeout: this.config.startup_ms,
        maxBuffer: 16384,
        signal,
      })
    ).stdout;
  }

  /**
   * Cancel MCP work, stop the isolated daemon, and remove its runtime directory only after
   * confirming daemon exit; fail if shutdown cannot be verified.
   */
  async close() {
    this.stop.abort();
    await this.client.close();
    // Recovery can close a backend from a previous service process. Its runtime
    // directory may already be gone, but daemon stop/status require it to exist.
    await mkdir(this.env.CBM_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    if (
      (await realpath(this.env.CBM_RUNTIME_DIR)) !== this.env.CBM_RUNTIME_DIR ||
      (await lstat(this.env.CBM_RUNTIME_DIR)).uid !== process.getuid!()
    )
      throw new Error("MCP runtime directory must be owned and canonical");
    const signal = AbortSignal.timeout(15000);
    try {
      await this.command(["daemon", "stop"], signal);
    } catch {
      const stopped = await this.command(["daemon", "status"], signal).then(
        () => false,
        (error) =>
          error.code === 1 &&
          String(error.stdout).includes("daemon: not running"),
      );
      if (!stopped)
        throw new Error("isolated Codebase Memory daemon could not be stopped");
    }
    for (let i = 0; i < 30; i++) {
      signal.throwIfAborted();
      const stopped = await this.command(["daemon", "status"], signal).then(
        () => false,
        (error) =>
          error.code === 1 &&
          String(error.stdout).includes("daemon: not running"),
      );
      if (stopped) {
        await rm(this.env.CBM_RUNTIME_DIR, { recursive: true, force: true });
        this.log.info(
          { stderrBytes: this.stderrBytes },
          "MCP backend cleanup completed",
        );
        return;
      }
      await delay(100);
    }
    throw new Error("isolated Codebase Memory daemon did not stop");
  }
}
