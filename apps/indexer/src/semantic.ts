import type { Tool } from "@modelcontextprotocol/client";
import { z } from "zod";

import type { IndexPreparation } from "@razbor/contracts";
import type { Database } from "@razbor/database";
import {
  cachedEmbeddings,
  cacheEmbeddings,
  embeddingIndex,
  publishEmbeddingIndex,
  searchEmbeddings,
  type EmbeddingChunk,
  type EmbeddingScope,
} from "@razbor/database/embeddings";
import { logger } from "@razbor/harness/logger";

import { MemoryBackend, releaseVersion } from "@indexer/src/backend.js";
import type { IndexerConfig } from "@indexer/src/config.js";
import {
  Embeddings,
  embeddingBatchSize,
  embeddingInputBytes,
  embeddingModel,
  embeddingRevision,
} from "@indexer/src/embeddings.js";
import {
  chunkSymbols,
  type SemanticChunk,
} from "@indexer/src/semantic-chunks.js";

const modelKey = `${embeddingModel}@${embeddingRevision}:mean-l2-v1`;

const searchArguments = z
  .object({
    query: z
      .string()
      .min(1)
      .max(embeddingInputBytes)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          Buffer.byteLength(value) <= embeddingInputBytes,
      ),
    kind: z.enum(["text", "code"]),
    limit: z.number().int().min(1).max(20).optional(),
    path_prefix: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.includes("\0") &&
          !value.split("/").some((part) => part === ".." || part === "."),
      )
      .optional(),
  })
  .strict();

export const semanticSearchTool: Tool = {
  name: "semantic_search",
  description:
    "Find related code in the authorized repository at its indexed commit using a local CodeSage embedding model. Supply natural language (kind=text) or a short code snippet (kind=code), at most 1800 UTF-8 bytes. Returns bounded source fragments from indexed functions/methods with locations and cosine similarity; scores are retrieval rankings, not confidence of correctness. Use get_code_snippet/read_file and trace_path to verify candidates. This covers only CBM-discovered functions/methods and does not prove absence or completeness.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: embeddingInputBytes },
      kind: { type: "string", enum: ["text", "code"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      path_prefix: { type: "string", minLength: 1, maxLength: 1024 },
    },
    required: ["query", "kind"],
    additionalProperties: false,
  },
};

export class SemanticIndex {
  private completed?: { headSha: string; chunkCount: number };
  private readonly chunkerVersion: string;

  /**
   * Bind semantic storage to one workspace and a chunker identity that includes the pinned
   * CBM release and indexing mode.
   */
  constructor(
    private readonly database: Database,
    private readonly scope: EmbeddingScope,
    private readonly config: IndexerConfig,
    private readonly embeddings: Embeddings,
  ) {
    this.chunkerVersion = `semantic-chunks-v1:cbm-${releaseVersion}:${config.memory.mode}`;
  }

  /**
   * Clear in-memory readiness without deleting persisted vectors or reusable embedding cache
   * entries.
   */
  reset() {
    this.completed = undefined;
  }

  /**
   * Expose the prepared revision, model identity, chunk count, and best-effort symbol
   * coverage only while this index is ready.
   */
  get status() {
    return this.completed
      ? {
          ...this.completed,
          model: embeddingModel,
          revision: embeddingRevision,
          chunkerVersion: this.chunkerVersion,
          coverage: "CBM-discovered functions and methods; best effort",
        }
      : undefined;
  }

  /**
   * Reuse an exact revision/model/chunker index or embed discovered symbols, then revalidate
   * source before publishing the complete index. Report completed source occurrences after
   * each cached batch, with a total only when traversal or an exact stored index is complete.
   */
  async prepare(
    backend: MemoryBackend,
    headSha: string,
    signal: AbortSignal,
    validateSource: () => Promise<void>,
    reportProgress?: (progress: IndexPreparation["code"]) => void,
  ) {
    this.reset();
    await this.embeddings.ready(signal);
    const identity = {
      headSha,
      model: modelKey,
      chunkerVersion: this.chunkerVersion,
    };
    const existing = await embeddingIndex(this.database, this.scope, identity);
    if (existing) {
      if (existing.chunkCount > this.config.embeddings!.max_chunks)
        throw new Error("stored semantic index exceeds configured chunk limit");
      await validateSource();
      signal.throwIfAborted();
      this.completed = { headSha, chunkCount: existing.chunkCount };
      reportProgress?.({
        processed: existing.chunkCount,
        total: existing.chunkCount,
      });
      return;
    }
    const started = performance.now();
    const chunks: EmbeddingChunk[] = [];
    let generated = 0;
    let reused = 0;
    const batch: SemanticChunk[] = [];
    /**
     * Reuse cached vectors by content hash, embed missing texts once, and append every
     * source occurrence to the pending index.
     */
    const flush = async () => {
      signal.throwIfAborted();
      const unique = [
        ...new Map(batch.map((chunk) => [chunk.contentHash, chunk])).values(),
      ];
      const cached = await cachedEmbeddings(
        this.database,
        this.scope,
        modelKey,
        unique.map((chunk) => chunk.contentHash),
      );
      const missing = unique.filter((chunk) => !cached.has(chunk.contentHash));
      if (missing.length) {
        const vectors = await this.embeddings.encode(
          missing.map((chunk) => chunk.text),
          signal,
        );
        await cacheEmbeddings(
          this.database,
          this.scope,
          modelKey,
          missing.map((chunk, index) => ({
            hash: chunk.contentHash,
            embedding: vectors[index],
          })),
        );
      }
      generated += missing.length;
      reused += unique.length - missing.length;
      for (const chunk of batch)
        chunks.push({
          id: String(chunks.length),
          hash: chunk.contentHash,
          path: chunk.path,
          qualifiedName: chunk.qualifiedName,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.content,
          partial: chunk.partial,
        });
      batch.length = 0;
      reportProgress?.({ processed: chunks.length });
    };
    for await (const chunk of chunkSymbols(
      backend.repository,
      backend.symbols(signal),
      this.config.embeddings!.max_chunks,
      signal,
    )) {
      batch.push(chunk);
      if (batch.length === embeddingBatchSize) await flush();
    }
    if (batch.length) await flush();
    reportProgress?.({ processed: chunks.length, total: chunks.length });
    await validateSource();
    signal.throwIfAborted();
    await publishEmbeddingIndex(this.database, this.scope, {
      ...identity,
      chunks,
    });
    signal.throwIfAborted();
    this.completed = { headSha, chunkCount: chunks.length };
    logger.info(
      {
        workspaceId: this.scope.workspaceId,
        repositoryId: this.scope.repositoryId,
        headSha,
        model: embeddingModel,
        revision: embeddingRevision,
        chunks: chunks.length,
        generated,
        reused,
        durationMs: Math.round(performance.now() - started),
      },
      "semantic index prepared",
    );
  }

  /**
   * Require the prepared revision, embed a bounded query, and return scoped similarity
   * results trimmed to the tool output budget.
   */
  async search(
    headSha: string,
    input: unknown,
    signal: AbortSignal,
    outputBytes: number,
  ) {
    if (this.completed?.headSha !== headSha)
      throw new Error("semantic index is not ready for this revision");
    const parsed = searchArguments.safeParse(input);
    if (!parsed.success)
      throw new Error(
        "invalid semantic search arguments; query must fit 1800 UTF-8 bytes",
      );
    const args = parsed.data;
    const started = performance.now();
    const [embedding] = await this.embeddings.encode([args.query], signal);
    signal.throwIfAborted();
    const found = await searchEmbeddings(this.database, this.scope, {
      headSha,
      model: modelKey,
      chunkerVersion: this.chunkerVersion,
      embedding,
      limit: args.limit ?? 8,
      pathPrefix: args.path_prefix,
    });
    signal.throwIfAborted();
    const results = found.map((chunk) => ({
      path: chunk.path,
      qualifiedName: chunk.qualifiedName,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      source: chunk.text,
      partial: chunk.partial,
      similarity: chunk.score,
    }));
    const output = {
      repositoryId: this.scope.repositoryId,
      project: this.scope.workspaceId,
      headSha,
      model: embeddingModel,
      revision: embeddingRevision,
      kind: args.kind,
      coverage:
        "CBM-discovered functions and methods; inspect source and coverage before drawing conclusions",
      results,
      truncated: false,
    };
    while (
      Buffer.byteLength(JSON.stringify(output)) > outputBytes &&
      results.length
    ) {
      results.pop();
      output.truncated = true;
    }
    if (found.length && !results.length)
      throw new Error("semantic search result exceeds tool output budget");
    logger.info(
      {
        workspaceId: this.scope.workspaceId,
        tool: "semantic_search",
        kind: args.kind,
        results: results.length,
        durationMs: Math.round(performance.now() - started),
      },
      "semantic search completed",
    );
    return JSON.stringify(output);
  }
}
