import type OpenAI from "openai";
import type { Logger } from "pino";

import type { PreparedCapabilities } from "@razbor/contracts";

import { renderPrompt } from "@harness/src/prompts.js";
import { boundedText } from "@harness/src/capabilities/files.js";
import { RemoteMemory } from "@harness/src/capabilities/mcp.js";
import { DurableMemory } from "@harness/src/capabilities/memory.js";
import { RemoteMcp } from "@harness/src/capabilities/remote-mcp.js";
import { SkillCatalog } from "@harness/src/capabilities/skills.js";

export class ReviewCapabilities {
  readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  readonly instructions: string[] = [];
  private memory?: RemoteMemory;
  private durableMemory?: DurableMemory;
  private skills?: SkillCatalog;
  private readonly mcpServers: RemoteMcp[] = [];
  private readonly mcpTools = new Map<string, RemoteMcp>();

  /**
   * Creates the per-review capability container from approved configuration and a
   * shared cancellation signal.
   */
  constructor(
    private readonly config: PreparedCapabilities | undefined,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
  ) {}

  /**
   * Starts approved capabilities, closing every partially opened remote connection
   * before propagating a startup failure.
   */
  async start() {
    try {
      await this.load();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Loads approved instructions and skills, connects revision-bound code navigation,
   * repository MCP servers and durable memory, then exposes their tool definitions.
   */
  private async load() {
    if (!this.config) return;
    for (const instruction of this.config.instructions) {
      const text = await boundedText(
        instruction.path,
        this.config.limits.instructionBytes,
      );
      this.instructions.push(
        await renderPrompt("repository-instructions", {
          provenance: instruction.provenance,
          scope: instruction.scope ?? null,
          text,
        }),
      );
      this.log.info(
        { provenance: instruction.provenance, bytes: Buffer.byteLength(text) },
        "approved instructions loaded",
      );
    }
    if (this.config.skills.length) {
      this.skills = new SkillCatalog(this.config.limits, this.log);
      await this.skills.discover(this.config.skills);
      this.instructions.push(await renderPrompt("skills-guidance"));
      this.tools.push(
        {
          type: "function",
          function: {
            name: "find_skill",
            description: await renderPrompt("tools/find-skill"),
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", minLength: 1, maxLength: 200 },
                limit: { type: "integer", minimum: 1, maximum: 10 },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "read_skill",
            description: await renderPrompt("tools/read-skill"),
            parameters: {
              type: "object",
              properties: {
                id: { type: "string", maxLength: 64 },
                resource: { type: "string", maxLength: 200 },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
      );
    }
    for (const skill of this.config.includedSkills ?? []) {
      const text = await boundedText(skill.path, this.config.limits.skillBytes);
      this.instructions.push(
        await renderPrompt("included-skill", {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          text,
        }),
      );
      this.log.info(
        {
          skillId: skill.id,
          name: skill.name,
          version: skill.version,
          mode: "always_include",
          bytes: Buffer.byteLength(text),
        },
        "skill included in initial review context",
      );
    }
    if (this.config.codebaseMemory) {
      this.memory = new RemoteMemory(
        this.config.codebaseMemory,
        this.log,
        this.signal,
        this.config.limits.toolOutputBytes,
      );
      await this.memory.start();
      this.instructions.push(
        await renderPrompt("index-context", {
          branch: this.config.codebaseMemory.indexBranch,
          indexHead: this.config.codebaseMemory.indexHeadSha,
        }),
      );
      this.tools.push(
        ...this.memory.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: `cbm_${tool.name}`,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      );
    }
    for (const [index, config] of (this.config.mcpServers ?? []).entries()) {
      const server = new RemoteMcp(
        config,
        index,
        this.log,
        this.signal,
        this.config.limits.toolOutputBytes,
      );
      this.mcpServers.push(server);
      await server.start();
      for (const tool of server.tools) {
        this.mcpTools.set(tool.name, server);
        this.tools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        });
      }
    }
    if (this.config.memory) {
      this.durableMemory = new DurableMemory(
        this.config.memory,
        this.log,
        this.signal,
        this.config.limits.toolOutputBytes,
      );
      this.durableMemory.start();
      this.instructions.push(await renderPrompt("memory-guidance"));
      this.tools.push(...this.durableMemory.tools);
    }
  }

  /**
   * Routes enabled skill, code navigation, MCP, or durable memory tools after checking
   * cancellation; rejects unknown or disabled capabilities.
   */
  async call(name: string, input: unknown) {
    this.signal.throwIfAborted();
    if (name === "find_skill" && this.skills) return this.skills.find(input);
    if (name === "read_skill" && this.skills) return this.skills.read(input);
    if (name.startsWith("cbm_") && this.memory)
      return this.memory.call(name.slice(4), input);
    if (name.startsWith("memory_") && this.durableMemory)
      return this.durableMemory.call(name, input);
    const server = this.mcpTools.get(name);
    if (server) return server.call(name, input);
    throw new Error("unknown or disabled tool");
  }

  /** Resets skill delivery deduplication while preserving approved capabilities and connections. */
  resetContext() {
    this.skills?.resetContext();
  }

  /** Closes every remote client, including clients whose startup failed. */
  async close() {
    const results = await Promise.allSettled([
      this.memory?.close(),
      ...this.mcpServers.map((server) => server.close()),
    ]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  }
}
