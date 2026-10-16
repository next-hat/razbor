import { z } from "zod";

import { publicIdSchema } from "@contracts/src/ids.js";

export const MAX_MEMORY_BYTES = 65536;

export const memoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      path.endsWith(".md") &&
      !path.includes("\\") &&
      [...path].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "Use a relative Markdown path without traversal or control characters",
  );

export const memoryMarkdownSchema = z
  .string()
  .max(MAX_MEMORY_BYTES)
  .refine(
    (markdown) => new TextEncoder().encode(markdown).length <= MAX_MEMORY_BYTES,
    "Markdown must be at most 64 KiB",
  )
  .refine(
    (markdown) => !markdown.includes("\0"),
    "Markdown cannot contain NUL",
  );

export const memoryTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (title) =>
      [...title].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    "Title cannot contain control characters",
  );

const memorySelectionSchema = z.object({
  collectionId: publicIdSchema("memoryCollection").optional(),
  pathPrefix: z
    .string()
    .max(512)
    .refine(
      (prefix) => !prefix.includes("\0"),
      "Path prefix cannot contain NUL",
    )
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
});

const memoryIdentitySchema = z.object({ id: publicIdSchema("memory") });

const memoryMutationSchema = memoryIdentitySchema.extend({
  expectedVersion: z.number().int().positive().safe(),
});

export const memoryOperationSchema = z.discriminatedUnion("operation", [
  memorySelectionSchema
    .extend({
      operation: z.literal("list"),
      includeDeleted: z.boolean().optional(),
    })
    .strict(),
  memorySelectionSchema
    .extend({
      operation: z.literal("search"),
      query: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .refine(
          (query) => !query.includes("\0"),
          "Search query cannot contain NUL",
        ),
    })
    .strict(),
  memoryIdentitySchema
    .extend({
      operation: z.literal("read"),
      revision: z.number().int().positive().safe().optional(),
    })
    .strict(),
  memoryIdentitySchema
    .extend({
      operation: z.literal("revisions"),
      limit: z.number().int().min(1).max(10).optional(),
      offset: z.number().int().min(0).max(100000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      collectionId: publicIdSchema("memoryCollection").optional(),
      path: memoryPathSchema,
      title: memoryTitleSchema,
      markdown: memoryMarkdownSchema,
    })
    .strict(),
  memoryMutationSchema
    .extend({
      operation: z.literal("write"),
      path: memoryPathSchema.optional(),
      title: memoryTitleSchema.optional(),
      markdown: memoryMarkdownSchema,
    })
    .strict(),
  memoryMutationSchema
    .extend({
      operation: z.literal("edit"),
      oldText: memoryMarkdownSchema.refine(
        (oldText) => oldText.length > 0,
        "Text to replace cannot be empty",
      ),
      newText: memoryMarkdownSchema,
    })
    .strict(),
  memoryMutationSchema.extend({ operation: z.literal("delete") }).strict(),
  memoryMutationSchema
    .extend({
      operation: z.literal("restore"),
      revision: z.number().int().positive().safe().optional(),
    })
    .strict(),
]);

export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

export type MemoryProvenance = {
  actor: "human" | "bot";
  reviewId?: string;
  headSha?: string;
};

export type MemoryCollection = {
  id: string;
  name: string;
  isDefault: boolean;
  canWrite: boolean;
};

export type MemorySummary = {
  id: string;
  collectionId: string;
  path: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type MemoryDocument = MemorySummary & { markdown: string };

export type MemoryRevision = MemoryProvenance & {
  version: number;
  path: string;
  title: string;
  markdown: string;
  deletedAt: string | null;
  createdAt: string;
};

export type MemoryOperationResult = {
  collections?: MemoryCollection[];
  documents?: MemorySummary[];
  document?: MemoryDocument;
  revisions?: MemoryRevision[];
  hasMore?: boolean;
};

export const memoryCapabilitySchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .refine(
        (endpoint) => /^https?:/.test(endpoint),
        "Memory endpoint must use HTTP or HTTPS",
      ),
    tokenEnv: z.literal("RAZBOR_MEMORY_TOKEN").default("RAZBOR_MEMORY_TOKEN"),
    queryMs: z.number().int().min(100).max(60000).default(15000),
  })
  .strict();
