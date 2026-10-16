import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client";
import type { ValidateFunction } from "ajv";
import type { Logger } from "pino";

import type { PreparedMcpServer } from "@razbor/contracts";

import { boundedOutput } from "@harness/src/capabilities/files.js";
import {
  compileMcpToolSchema,
  discoverTools,
} from "@harness/src/capabilities/mcp.js";

/** Produces a bounded function-name component from an untrusted MCP tool name. */
function namePart(value: string, limit: number) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, limit) || "tool";
}

/**
 * Extracts structured content or text without dereferencing resource links or
 * including server error details in the agent's diagnostics.
 */
function toolResultText(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}) {
  if (result.isError) throw new Error("MCP tool failed");
  if (result.structuredContent !== undefined) {
    const text = JSON.stringify(result.structuredContent);
    if (text === undefined) throw new Error("invalid MCP result");
    return text;
  }
  if (!Array.isArray(result.content)) throw new Error("invalid MCP result");
  return result.content
    .filter(
      (item) => item && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export class RemoteMcp {
  private readonly client = new Client({
    name: "razbor-agent",
    version: "0.1.0",
  });

  readonly tools: Tool[] = [];

  private transport?: StreamableHTTPClientTransport;

  private readonly upstreamTools = new Map<
    string,
    { name: string; validate: ValidateFunction }
  >();

  /** Stores one approved broker connection and its review-scoped execution policy. */
  constructor(
    private readonly config: PreparedMcpServer,
    private readonly namespace: number,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
    private readonly maxBytes: number,
  ) {}

  /** Applies cancellation and request deadlines, allowing at most two seconds for session cleanup. */
  private async fetch(
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) {
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(
        init?.method === "DELETE" ? 2000 : this.config.queryMs,
      ),
      ...(init?.signal ? [init.signal] : []),
      ...(url instanceof Request ? [url.signal] : []),
    ]);
    return fetch(url, { ...init, redirect: "error", signal });
  }

  /**
   * Connects over Streamable HTTP using the attempt token, discovers tools within
   * one startup deadline, and compiles their schemas before exposing any tool.
   */
  async start() {
    const token = process.env[this.config.tokenEnv];
    if (!token) throw new Error("MCP enabled but RAZBOR_MCP_TOKEN is missing");
    const endpoint = new URL(this.config.endpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid MCP endpoint");
    const start = performance.now();
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(this.config.startupMs),
    ]);
    try {
      this.transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
        },
        fetch: this.fetch.bind(this),
      });
      await this.client.connect(this.transport, {
        signal,
        timeout: this.config.startupMs,
      });
      const discovered = await discoverTools(
        this.client,
        signal,
        this.config.startupMs,
      );
      const names = new Set<string>();
      // Sorting makes aliases independent of pagination order. Numeric namespaces
      // keep aliases unique even when server or upstream names normalize equally.
      discovered.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const [index, tool] of discovered.entries()) {
        if (names.has(tool.name)) throw new Error("duplicate MCP tool name");
        names.add(tool.name);
        const name = `mcp_${this.namespace}_${namePart(this.config.name, 20)}_${index}_${namePart(tool.name, 30)}`;
        this.upstreamTools.set(name, {
          name: tool.name,
          validate: compileMcpToolSchema(tool.inputSchema),
        });
        this.tools.push({
          name,
          description: `MCP server ${this.config.name}: ${tool.description ?? tool.name}`,
          inputSchema: tool.inputSchema,
        });
      }
      this.log.info(
        {
          serverId: this.config.id,
          toolCount: this.tools.length,
          durationMs: Math.round(performance.now() - start),
        },
        "repository MCP connected",
      );
    } catch {
      // Upstream errors can contain request headers or remote response bodies.
      throw new Error(
        `MCP server ${this.config.name} could not be initialized`,
      );
    }
  }

  /** Validates exposed arguments, calls the exact upstream name, and bounds output. */
  async call(name: string, input: unknown) {
    this.signal.throwIfAborted();
    const tool = this.upstreamTools.get(name);
    if (!tool) throw new Error("unknown or disabled MCP tool");
    if (!tool.validate(input)) throw new Error("invalid MCP tool arguments");
    const start = performance.now();
    try {
      const result = await this.client.callTool(
        { name: tool.name, arguments: input as Record<string, unknown> },
        { signal: this.signal, timeout: this.config.queryMs },
      );
      const text = toolResultText(result);
      this.log.info(
        {
          serverId: this.config.id,
          durationMs: Math.round(performance.now() - start),
          bytes: Buffer.byteLength(text),
        },
        "repository MCP tool completed",
      );
      return boundedOutput(text, this.maxBytes);
    } catch {
      throw new Error(`MCP server ${this.config.name} tool call failed`);
    }
  }

  /**
   * Best-effort terminates the server session before closing every transport.
   * Cleanup failures never replace an accepted review or the original startup error.
   */
  async close() {
    const transport = this.transport;
    this.transport = undefined;
    try {
      await transport?.terminateSession().catch(() => undefined);
    } finally {
      await this.client.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
    }
  }
}
