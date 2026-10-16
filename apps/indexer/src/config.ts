import { readFile } from "node:fs/promises";

import { z } from "zod";
import { parse } from "smol-toml";

import {
  identifier,
  absolute,
  repositoryConfigSchema,
} from "@razbor/harness/git-policy";

const secretReference = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
  z.object({ file: absolute }).strict(),
]);

export const indexerConfigSchema = z
  .object({
    service: z
      .object({
        owner: identifier.default("local-indexer"),
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(0).max(65535).default(8790),
        data_root: absolute,
        management_token: secretReference,
        sync_ms: z.number().int().min(1000).max(300000).default(60000),
        max_reviews: z.number().int().min(1).max(64).default(8),
      })
      .strict(),
    memory: z
      .object({
        executable: absolute,
        mode: z.enum(["fast", "moderate", "full"]).default("full"),
        startup_ms: z.number().int().min(1000).max(60000).default(15000),
        index_ms: z.number().int().min(1000).max(300000).default(90000),
        query_ms: z.number().int().min(100).max(60000).default(15000),
        tool_output_bytes: z
          .number()
          .int()
          .min(1024)
          .max(200000)
          .default(32768),
      })
      .strict(),
    embeddings: z
      .object({
        endpoint: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              url.pathname === "/"
            );
          }, "embedding endpoint must be an HTTP(S) origin"),
        token: secretReference,
        request_ms: z.number().int().min(1000).max(300000).default(60000),
        index_ms: z.number().int().min(1000).max(3600000).default(600000),
        max_chunks: z.number().int().min(1).max(20000).default(20000),
      })
      .strict()
      .optional(),
    repositories: z.record(identifier, repositoryConfigSchema).default({}),
    tokens: z
      .array(
        z
          .object({
            id: identifier,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            repository: identifier,
            refresh: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>(),
      hashes = new Set<string>();
    for (const token of value.tokens) {
      if (
        !Object.hasOwn(value.repositories, token.repository) ||
        ids.has(token.id) ||
        hashes.has(token.sha256)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "tokens require an approved repository and unique IDs/hashes",
        });
      ids.add(token.id);
      hashes.add(token.sha256);
    }
  });

export type IndexerConfig = z.infer<typeof indexerConfigSchema>;

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

/**
 * Resolve the management token from its approved environment or file reference and reject
 * short, empty, or multiline secrets.
 */
export async function managementSecret(config: IndexerConfig) {
  const ref = config.service.management_token;
  const token =
    "env" in ref
      ? process.env[ref.env]
      : (await readFile(ref.file, "utf8")).trimEnd();
  if (!token || token.length < 32 || /[\r\n\0]/.test(token))
    throw new Error(
      "index management token must contain at least 32 characters",
    );
  return token;
}

/**
 * Read and validate indexer TOML, applying defaults and checking repository/token
 * relationships.
 */
export async function loadIndexerConfig(file: string) {
  return indexerConfigSchema.parse(parse(await readFile(file, "utf8")));
}
