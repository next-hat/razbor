import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Logger } from "pino";

import type { PreparedCapabilities } from "@razbor/contracts";

import { boundedOutput } from "@harness/src/capabilities/files.js";

export const readOnlyTools = [
  "search_graph",
  "trace_path",
  "get_code_snippet",
  "get_architecture",
  "get_graph_schema",
  "search_code",
  "check_index_coverage",
  "index_status",
] as const;

/**
 * Compiles a tool's declared draft-07 schema or MCP's default 2020-12 dialect.
 * Each tool gets an isolated validator so schema IDs cannot collide across tools;
 * unsupported dialects and invalid schemas fail without exposing schema details.
 */
export function compileMcpToolSchema(schema: Tool["inputSchema"]) {
  const dialect =
    typeof schema.$schema === "string"
      ? schema.$schema.replace(/#$/, "")
      : schema.$schema;
  const engine =
    dialect === undefined ||
    dialect === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : dialect === "http://json-schema.org/draft-07/schema"
        ? Ajv
        : undefined;
  if (!engine) throw new Error("unsupported MCP input schema dialect");
  try {
    return new engine({
      strict: false,
      allErrors: false,
      logger: false,
    }).compile(schema);
  } catch {
    throw new Error("invalid MCP tool input schema");
  }
}

/**
 * Extracts one authoritative MCP result representation, preferring structured content.
 * Rejects tool errors and never dereferences returned resources.
 */
export function resultText(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}) {
  if (result.isError)
    throw new Error("Codebase Memory tool failed; this is not an empty result");
  if (result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent);
  if (!Array.isArray(result.content)) throw new Error("invalid MCP result");
  // Resource links are data only. Never dereference them or duplicate structured content.
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

/**
 * Collects paginated MCP tool definitions with per-request deadlines, rejecting
 * repeated cursors or more than 100 tools.
 */
export async function discoverTools(
  client: Client,
  signal: AbortSignal,
  timeout: number,
) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, {
      signal,
      timeout,
    });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (tools.length > 100 || (cursor && seen.has(cursor)))
      throw new Error("invalid MCP tool pagination");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools;
}

export class BoundTools {
  readonly tools: Tool[] = [];
  private readonly validators = new Map<
    string,
    { input: ValidateFunction; upstream: ValidateFunction; project: boolean }
  >();

  /**
   * Builds the permitted tool surface, hiding the fixed project selector and compiling
   * client and upstream schemas. Rejects missing required tools or repository
   * selectors.
   */
  constructor(
    discovered: Tool[],
    private readonly project: string,
    options: { semanticSearch?: boolean; documentSearch?: boolean } = {},
  ) {
    const ajv = new Ajv({ strict: false, allErrors: false });
    const allowedTools: string[] = [...readOnlyTools];
    // This extension belongs to the razbor proxy, not the upstream CBM server.
    if (
      options.semanticSearch &&
      discovered.some((tool) => tool.name === "semantic_search")
    )
      allowedTools.push("semantic_search");
    if (
      options.documentSearch &&
      discovered.some((tool) => tool.name === "search_documents")
    )
      allowedTools.push("search_documents");
    for (const name of allowedTools) {
      const tool = discovered.find((item) => item.name === name);
      if (!tool)
        throw new Error(`required Codebase Memory tool missing: ${name}`);
      const upstream = ajv.compile(tool.inputSchema);
      const schema = structuredClone(tool.inputSchema);
      const hasProject = Object.hasOwn(schema.properties ?? {}, "project");
      if (hasProject) delete schema.properties!.project;
      schema.required = schema.required?.filter((key) => key !== "project");
      schema.additionalProperties = false;
      // No other tool may acquire a filesystem root or change projects through selectors.
      for (const key of [
        "repo_path",
        "repository",
        "projects",
        "target_projects",
      ])
        if (Object.hasOwn(schema.properties ?? {}, key))
          throw new Error(`unexpected selector in ${name}`);
      this.validators.set(name, {
        input: ajv.compile(schema),
        upstream,
        project: hasProject,
      });
      this.tools.push({
        name,
        description: tool.description,
        inputSchema: schema,
      });
    }
  }

  /**
   * Validates exposed tool arguments, injects the fixed project where required, then
   * validates the complete upstream request.
   */
  arguments(name: string, input: unknown) {
    const validator = this.validators.get(name);
    if (!validator) throw new Error("MCP tool is not allowed");
    if (!validator.input(input)) throw new Error("invalid MCP tool arguments");
    const args = {
      ...(input as Record<string, unknown>),
      ...(validator.project ? { project: this.project } : {}),
    };
    if (!validator.upstream(args))
      throw new Error("MCP arguments do not match server schema");
    return args;
  }
}

export class RemoteMemory {
  private readonly client = new Client({
    name: "razbor-agent",
    version: "0.1.0",
  });
  tools: Tool[] = [];
  private bound?: BoundTools;

  /**
   * Stores remote connection policy, cancellation, output limits, and the logger
   * without opening a connection.
   */
  constructor(
    private readonly config: NonNullable<
      PreparedCapabilities["codebaseMemory"]
    >,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
    private readonly maxBytes: number,
  ) {}

  /**
   * Connects with the configured bearer token and redirects disabled, binds approved
   * tools, and requires a ready index at the recorded review head.
   */
  async start() {
    const start = performance.now();
    const token = process.env[this.config.tokenEnv];
    if (!token)
      throw new Error(
        "Codebase Memory enabled but RAZBOR_MCP_TOKEN is missing",
      );
    const endpoint = new URL(this.config.endpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid MCP endpoint");
    await this.client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
        },
      }),
      { signal: this.signal, timeout: this.config.startupMs },
    );
    // The proxy removes project from its schema. The configured binding is confirmed
    // by index_status before the model sees any tools or approved instructions.
    this.bound = new BoundTools(
      await discoverTools(this.client, this.signal, this.config.startupMs),
      this.config.project,
      { semanticSearch: true, documentSearch: true },
    );
    this.tools = this.bound.tools;
    const status = JSON.parse(
      await this.call("index_status", { format: "json" }),
    );
    if (
      status.project !== this.config.project ||
      status.status !== "ready" ||
      status.headSha !== this.config.indexHeadSha
    )
      throw new Error(
        "Codebase Memory project is not ready or does not match this job",
      );
    this.log.info(
      {
        serverVersion: this.client.getServerVersion()?.version,
        durationMs: Math.round(performance.now() - start),
        project: this.config.project,
        tools: this.tools.map((tool) => tool.name),
      },
      "MCP connected",
    );
  }

  /**
   * Invokes a bound tool with the query deadline and cancellation signal, logs
   * execution metadata, and bounds the returned text.
   */
  async call(name: string, input: unknown) {
    if (!this.bound) throw new Error("MCP is not initialized");
    const start = performance.now();
    const result = await this.client.callTool(
      { name, arguments: this.bound.arguments(name, input) },
      { signal: this.signal, timeout: this.config.queryMs },
    );
    const text = resultText(result);
    this.log.info(
      {
        tool: name,
        project: this.config.project,
        durationMs: Math.round(performance.now() - start),
        bytes: Buffer.byteLength(text),
      },
      "MCP tool completed",
    );
    return boundedOutput(text, this.maxBytes);
  }

  /**
   * Closes the MCP client connection before reporting that the remote capability has
   * stopped.
   */
  async close() {
    await this.client.close();
    this.log.info("MCP connection closed");
  }
}
