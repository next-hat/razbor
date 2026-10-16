import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { IndexerConfig } from "@indexer/src/config.js";

export const embeddingModel = "codesage/codesage-small-v2";

export const embeddingRevision = "4844c2f24b25e181aa43ca058cc73dd2622565c1";

export const embeddingDimensions = 1024;

export const embeddingInputBytes = 1800;

export const embeddingBatchSize = 8;

export const documentEmbeddingModel = "intfloat/multilingual-e5-small";

export const documentEmbeddingRevision =
  "614241f622f53c4eeff9890bdc4f31cfecc418b3";

export const documentEmbeddingDimensions = 384;

export const documentEmbeddingInputBytes = 480;

const identity = {
  model: z.literal(embeddingModel),
  revision: z.literal(embeddingRevision),
  dimensions: z.literal(embeddingDimensions),
};

const healthSchema = z.object({
  ...identity,
  maxTokens: z.literal(2048),
  maxInputBytes: z.literal(embeddingInputBytes),
  maxBatchSize: z.literal(embeddingBatchSize),
});

const responseSchema = z.object({
  ...identity,
  embeddings: z.array(z.array(z.number().finite()).length(embeddingDimensions)),
});

const documentIdentity = {
  model: z.literal(documentEmbeddingModel),
  revision: z.literal(documentEmbeddingRevision),
  dimensions: z.literal(documentEmbeddingDimensions),
};

const documentHealthSchema = z.object({
  ...documentIdentity,
  maxTokens: z.literal(512),
  maxInputBytes: z.literal(documentEmbeddingInputBytes),
  maxBatchSize: z.literal(embeddingBatchSize),
});

const documentResponseSchema = z.object({
  ...documentIdentity,
  embeddings: z.array(
    z.array(z.number().finite()).length(documentEmbeddingDimensions),
  ),
});

const documentTokenLimitSchema = z.object({
  error: z.literal("input_token_limit_exceeded"),
});

export class DocumentEmbeddingTokenLimitError extends Error {
  /**
   * Identify confirmed document tokenizer overflow so indexing can retry smaller source
   * spans.
   */
  constructor() {
    super("document embedding input exceeds the supported token limit");
    this.name = "DocumentEmbeddingTokenLimitError";
  }
}

export class Embeddings {
  private tail: Promise<unknown> = Promise.resolve();

  /** Bind the embedding client to resolved credentials and a fixed transport configuration. */
  private constructor(
    private readonly config: NonNullable<IndexerConfig["embeddings"]>,
    private readonly token: string,
  ) {}

  /**
   * Resolve and validate the service secret before constructing an authenticated embedding
   * client.
   */
  static async create(config: NonNullable<IndexerConfig["embeddings"]>) {
    const token =
      "env" in config.token
        ? process.env[config.token.env]
        : (await readFile(config.token.file, "utf8")).trimEnd();
    if (!token || token.length < 32 || !/^[\x21-\x7e]+$/.test(token))
      throw new Error(
        "embedding service token must contain at least 32 printable ASCII characters without whitespace",
      );
    return new Embeddings(config, token);
  }

  /**
   * Call a fixed embedding route without redirects under the caller and request deadlines,
   * preserving only the recognized document token-limit failure.
   */
  private async request(
    route: string,
    signal: AbortSignal,
    texts?: string[],
    purpose?: "query" | "passage",
  ) {
    const active = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.config.request_ms),
    ]);
    let response: Response;
    try {
      response = await fetch(new URL(route, this.config.endpoint), {
        method: texts ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(texts ? { "Content-Type": "application/json" } : {}),
        },
        body: texts
          ? JSON.stringify({ texts, ...(purpose ? { purpose } : {}) })
          : undefined,
        signal: active,
        redirect: "error",
      });
    } catch {
      active.throwIfAborted();
      throw new Error("embedding service request failed");
    }
    const documentLimitResponse =
      route === "/documents/embed" && response.status === 413;
    if ((!response.ok && !documentLimitResponse) || !response.body) {
      await response.body?.cancel();
      throw new Error("embedding service rejected the request");
    }
    return this.readResponse(response.body, active, documentLimitResponse);
  }

  /**
   * Read bounded, valid UTF-8 JSON and distinguish confirmed document token overflow; cancel
   * the reader on every outcome.
   */
  private async readResponse(
    stream: ReadableStream<Uint8Array>,
    active: AbortSignal,
    documentLimitResponse: boolean,
  ) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        active.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > (documentLimitResponse ? 4096 : 1_000_000))
          throw new Error("embedding response exceeds limit");
        chunks.push(chunk.value);
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        throw new Error("invalid embedding service response");
      }
      if (documentLimitResponse) {
        if (documentTokenLimitSchema.safeParse(value).success)
          throw new DocumentEmbeddingTokenLimitError();
        throw new Error("embedding service rejected the request");
      }
      return value;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Verify that the code embedding service advertises the exact pinned model, revision,
   * dimensions, and input limits.
   */
  async ready(signal: AbortSignal) {
    if (!healthSchema.safeParse(await this.request("/health", signal)).success)
      throw new Error(
        "embedding service model or limits do not match the pinned configuration",
      );
  }

  /**
   * Verify the document embedding service against its pinned model identity and supported
   * limits.
   */
  async readyDocuments(signal: AbortSignal) {
    if (
      !documentHealthSchema.safeParse(
        await this.request("/documents/health", signal),
      ).success
    )
      throw new Error(
        "document embedding service model or limits do not match the pinned configuration",
      );
  }

  /**
   * Serialize code embedding batches with other inference work while checking cancellation
   * before dispatch.
   */
  async encode(texts: string[], signal: AbortSignal) {
    const result = this.tail
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted();
        return this.encodeBatch(texts, signal);
      });
    this.tail = result;
    return result;
  }

  /**
   * Serialize document query or passage embeddings through the same inference queue used by
   * code embeddings.
   */
  async encodeDocuments(
    texts: string[],
    purpose: "query" | "passage",
    signal: AbortSignal,
  ) {
    const result = this.tail
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted();
        return this.encodeBatch(texts, signal, purpose);
      });
    this.tail = result;
    return result;
  }

  /**
   * Validate input bounds, request the correct model route, and reject mismatched vector
   * counts, identities, dimensions, or normalization.
   */
  private async encodeBatch(
    texts: string[],
    signal: AbortSignal,
    purpose?: "query" | "passage",
  ) {
    const inputBytes = purpose
      ? documentEmbeddingInputBytes
      : embeddingInputBytes;
    if (
      !texts.length ||
      texts.length > embeddingBatchSize ||
      texts.some((text) => !text.trim() || Buffer.byteLength(text) > inputBytes)
    )
      throw new Error(
        "embedding input exceeds the supported batch or text limit",
      );
    const schema = purpose ? documentResponseSchema : responseSchema;
    const parsed = schema.safeParse(
      await this.request(
        purpose ? "/documents/embed" : "/embed",
        signal,
        texts,
        purpose,
      ),
    );
    if (!parsed.success || parsed.data.embeddings.length !== texts.length)
      throw new Error("invalid embedding service response");
    for (const vector of parsed.data.embeddings) {
      const norm = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0),
      );
      if (Math.abs(norm - 1) > 0.001)
        throw new Error("embedding service returned a non-normalized vector");
    }
    return parsed.data.embeddings;
  }
}
