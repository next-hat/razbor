import type OpenAI from "openai";
import type { Logger } from "pino";
import { z } from "zod";

import {
  MAX_MEMORY_BYTES,
  memoryOperationSchema,
  type MemoryOperation,
  type MemoryOperationResult,
  type PreparedCapabilities,
} from "@razbor/contracts";

const selectionProperties = {
  collectionId: { type: "string" },
  pathPrefix: { type: "string", maxLength: 512 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  offset: { type: "integer", minimum: 0, maximum: 100000 },
};

const identityProperties = { id: { type: "string" } };

const mutationProperties = {
  ...identityProperties,
  expectedVersion: { type: "integer", minimum: 1 },
};

const markdownProperty = { type: "string", maxLength: MAX_MEMORY_BYTES };

const definitions: {
  operation: MemoryOperation["operation"];
  description: string;
  properties: Record<string, unknown>;
  required: string[];
}[] = [
  {
    operation: "list",
    description:
      "List attached memory collections and Markdown document metadata. Use collectionId and pathPrefix to narrow results; includeDeleted reveals documents that can be restored. Collection canWrite determines which collections you may change.",
    properties: {
      ...selectionProperties,
      includeDeleted: { type: "boolean" },
    },
    required: [],
  },
  {
    operation: "search",
    description:
      "Search indexed memory titles and Markdown with full-text search. Returns document metadata; read promising documents before relying on their contents. Searches only collections attached to this review's project.",
    properties: {
      ...selectionProperties,
      query: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["query"],
  },
  {
    operation: "read",
    description:
      "Read a Markdown memory document or an immutable historical revision. Omit revision to read the current document and version. offset and limit address characters in the Markdown, defaulting to the first 4096 characters. contentRange reports the returned range, totalCharacters, and hasMore; continue at end to read the next page. Current-document pages must have the same version; restart reading if it changes. Read the current document before restoring a historical revision to obtain expectedVersion.",
    properties: {
      ...identityProperties,
      revision: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0, maximum: MAX_MEMORY_BYTES },
      limit: { type: "integer", minimum: 1, maximum: 16384 },
    },
    required: ["id"],
  },
  {
    operation: "create",
    description:
      "Persist a new Markdown memory document immediately and index it for future reviews. Use a relative .md path, a concise title, and at most 64 KiB of Markdown. Omitting collectionId selects the default project collection. Record durable verified knowledge and its evidence; search for an existing document first.",
    properties: {
      collectionId: { type: "string" },
      path: { type: "string", minLength: 1, maxLength: 512 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      markdown: markdownProperty,
    },
    required: ["path", "title", "markdown"],
  },
  {
    operation: "write",
    description:
      "Replace an entire memory document with Markdown and optionally rename its path or title. expectedVersion must be the version you read. Success means the revision is durable and searchable; a conflict requires reading the current document and reconciling changes before retrying.",
    properties: {
      ...mutationProperties,
      path: { type: "string", minLength: 1, maxLength: 512 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      markdown: markdownProperty,
    },
    required: ["id", "expectedVersion", "markdown"],
  },
  {
    operation: "edit",
    description:
      "Persist a targeted Markdown edit by replacing exactly one occurrence of oldText with newText. expectedVersion must be the version you read. A missing or repeated match rejects the edit. On version conflict, reread and reconcile; never retry by merely increasing the version.",
    properties: {
      ...mutationProperties,
      oldText: { ...markdownProperty, minLength: 1 },
      newText: markdownProperty,
    },
    required: ["id", "expectedVersion", "oldText", "newText"],
  },
  {
    operation: "delete",
    description:
      "Remove an obsolete memory document from normal retrieval while retaining its revision history for restoration. Requires the current expectedVersion and write access to its collection.",
    properties: mutationProperties,
    required: ["id", "expectedVersion"],
  },
  {
    operation: "revisions",
    description:
      "List memory revision metadata and provenance, including bot review commits or human edits. Read historical Markdown with memory_read using the revision's version number before choosing a version to restore.",
    properties: {
      ...identityProperties,
      limit: { type: "integer", minimum: 1, maximum: 2 },
      offset: { type: "integer", minimum: 0, maximum: 100000 },
    },
    required: ["id"],
  },
  {
    operation: "restore",
    description:
      "Create a new durable revision by restoring a historical version or undeleting the current document when revision is omitted. Requires the current expectedVersion; concurrent changes return a conflict.",
    properties: {
      ...mutationProperties,
      revision: { type: "integer", minimum: 1 },
    },
    required: ["id", "expectedVersion"],
  },
];

const readArgumentsSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive().safe().optional(),
    offset: z.number().int().min(0).max(MAX_MEMORY_BYTES).default(0),
    limit: z.number().int().min(1).max(16384).default(4096),
  })
  .strict();

/** Collect a JSON response within the transport bound without silently truncating it. */
async function responseText(response: Response) {
  if (!response.body) throw new Error("memory service returned no response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1048576)
      throw new Error("memory response exceeds 1 MiB; use a smaller limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class DurableMemory {
  readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  private endpoint?: URL;
  private token?: string;

  /** Store the attempt-bound transport, cancellation signal, and output budget. */
  constructor(
    private readonly config: NonNullable<PreparedCapabilities["memory"]>,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
    private readonly maxBytes: number,
  ) {}

  /** Validate the local relay configuration and expose the fixed file-style tools. */
  start() {
    this.token = process.env[this.config.tokenEnv];
    if (!this.token)
      throw new Error("memory enabled but RAZBOR_MEMORY_TOKEN is missing");
    const endpoint = new URL(this.config.endpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("invalid memory endpoint");
    this.endpoint = endpoint;
    this.tools.push(
      ...definitions.map(
        ({ operation, description, properties, required }) => ({
          type: "function" as const,
          function: {
            name: `memory_${operation}`,
            description,
            parameters: {
              type: "object",
              properties,
              required,
              additionalProperties: false,
            },
          },
        }),
      ),
    );
  }

  /**
   * Validate one operation, call the fixed relay with cancellation and a deadline, and
   * return bounded valid JSON. Mutations acknowledge durable server writes directly.
   */
  async call(name: string, input: unknown) {
    this.signal.throwIfAborted();
    if (!this.endpoint || !this.token)
      throw new Error("memory is not initialized");
    const operation = definitions.find(
      (item) => `memory_${item.operation}` === name,
    )?.operation;
    if (
      !operation ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      throw new Error("invalid memory tool arguments");
    const args = input as Record<string, unknown>;
    const range =
      operation === "read" ? readArgumentsSchema.parse(args) : undefined;
    const parsed = memoryOperationSchema.parse({
      ...(operation === "revisions" ? { limit: 1 } : {}),
      ...(range ? { id: range.id, revision: range.revision } : args),
      operation,
    });
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(this.config.queryMs),
    ]);
    const started = performance.now();
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parsed),
    });
    const result = JSON.parse(await responseText(response));
    signal.throwIfAborted();
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("invalid memory service response");
    if (!response.ok) {
      const reason =
        typeof result.error === "string"
          ? result.error.slice(0, 500)
          : "operation rejected";
      const current = result.current;
      const conflict =
        response.status === 409 && current
          ? `; current document ${String(current.id)} is version ${String(current.version)}. Read it again and reconcile your changes before retrying`
          : "";
      throw new Error(
        `memory operation failed (${response.status}): ${reason}${conflict}`,
      );
    }
    this.log.info(
      { operation, durationMs: Math.round(performance.now() - started) },
      "memory operation completed",
    );
    return this.formatResult(parsed, result, range);
  }

  /**
   * Preserve document identity and versions while paging reads and omitting repeated
   * Markdown from mutation acknowledgements and revision metadata.
   */
  private formatResult(
    operation: MemoryOperation,
    result: MemoryOperationResult,
    range?: z.infer<typeof readArgumentsSchema>,
  ) {
    const output: Record<string, unknown> = { ...result };
    if (result.document) {
      const { markdown, ...metadata } = result.document;
      output.document = metadata;
      if (operation.operation === "read" && range) {
        let offset = Math.min(range.offset, markdown.length);
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(markdown[offset])) offset--;
        let end = Math.min(offset + range.limit, markdown.length);
        if (end < markdown.length && /[\uD800-\uDBFF]/.test(markdown[end - 1]))
          end++;
        for (;;) {
          // Keep surrogate pairs together and require progress when shrinking a page.
          output.document = {
            ...metadata,
            markdown: markdown.slice(offset, end),
          };
          output.contentRange = {
            offset,
            end,
            totalCharacters: markdown.length,
            hasMore: end < markdown.length,
          };
          const text = JSON.stringify(output);
          if (Buffer.byteLength(text) <= this.maxBytes) return text;
          let nextEnd = offset + Math.floor((end - offset) / 2);
          if (nextEnd > offset && /[\uD800-\uDBFF]/.test(markdown[nextEnd - 1]))
            nextEnd--;
          if (nextEnd <= offset)
            throw new Error(
              "memory metadata and first character exceed the tool output limit",
            );
          end = nextEnd;
        }
      }
    }
    if (result.revisions)
      output.revisions = result.revisions.map((revision) => {
        const metadata: Record<string, unknown> = { ...revision };
        delete metadata.markdown;
        return metadata;
      });
    const text = JSON.stringify(output);
    if (Buffer.byteLength(text) > this.maxBytes)
      throw new Error(
        "memory result exceeds the tool output limit; use a smaller limit or narrower filters",
      );
    return text;
  }
}
