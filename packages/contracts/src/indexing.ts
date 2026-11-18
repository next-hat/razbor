import { z } from "zod";

import { publicIdSchema } from "@contracts/src/ids.js";

export const codebaseMemoryUnavailableMessage =
  "Codebase Memory is enabled for this repository but unavailable on the source service. Configure the service with the supported bundle or disable Codebase Memory for this repository, then retry.";

export const codebaseMemoryUnavailableCode = "codebase_memory_unavailable";

export const sourceHealthSchema = z.object({
  status: z.literal("ready"),
  capabilities: z.object({ codebaseMemory: z.boolean() }).optional(),
});

const corpusProgressSchema = z
  .object({
    processed: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

export const indexPreparationSchema = z
  .object({
    state: z.enum(["queued", "running", "ready", "error"]),
    phase: z.enum([
      "queued",
      "source_sync",
      "graph_bootstrap",
      "graph_readiness",
      "source_validation",
      "semantic_index",
      "document_index",
      "readiness_publication",
      "ready",
      "error",
    ]),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deadlineAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    code: corpusProgressSchema,
    documents: corpusProgressSchema,
    errorCode: z.enum(["timeout", "cancelled", "failed"]).optional(),
  })
  .strict();

export type IndexPreparation = z.infer<typeof indexPreparationSchema>;

export const indexPreparationSnapshotSchema = z
  .object({
    repositoryId: publicIdSchema("repository"),
    workspaceId: publicIdSchema("workspace").optional(),
    preparation: indexPreparationSchema.nullable(),
  })
  .strict();

export type IndexPreparationSnapshot = z.infer<
  typeof indexPreparationSnapshotSchema
>;

export const indexPreparationSnapshotsSchema = z
  .array(indexPreparationSnapshotSchema)
  .max(1000);

export const indexPreparationStatusRequestSchema = z
  .object({
    repositoryIds: z.array(publicIdSchema("repository")).min(1).max(1000),
  })
  .strict();
