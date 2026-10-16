import { z } from "zod";

import { publicIdSchema } from "@contracts/src/ids.js";

export const MAX_REPOSITORY_MCP_SERVERS = 16;

const serverNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** Reject header delimiters and other ASCII controls from endpoint URLs. */
function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const endpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (
      !/^https?:\/\//i.test(value) ||
      /\s/.test(value) ||
      hasControlCharacters(value)
    )
      return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !value.includes("#") &&
        url.toString().length <= 2048
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).toString());

export const mcpServerInputSchema = z
  .object({
    name: serverNameSchema,
    endpoint: endpointSchema,
    token: z
      .string()
      .trim()
      .max(8192)
      .refine((value) => /^[\x20-\x7E]*$/.test(value))
      .optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export const mcpServerSnapshotSchema = z
  .object({
    id: publicIdSchema("mcpServer"),
    name: serverNameSchema,
  })
  .strict();

export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export type McpServerView = McpServerSnapshot & {
  endpoint: string;
  enabled: boolean;
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
};

export const repositoryMcpAccessSchema = z
  .object({
    serverIds: z
      .array(publicIdSchema("mcpServer"))
      .max(MAX_REPOSITORY_MCP_SERVERS)
      .default([]),
  })
  .strict()
  .refine(
    (value) => new Set(value.serverIds).size === value.serverIds.length,
    "Selected MCP servers must be unique.",
  );

export type RepositoryMcpAccess = z.infer<typeof repositoryMcpAccessSchema>;

export const preparedMcpServerSchema = mcpServerSnapshotSchema
  .extend({
    endpoint: endpointSchema.refine(
      (value) => !new URL(value).search && !value.includes("?"),
      "Prepared MCP endpoints must not contain a query.",
    ),
    tokenEnv: z.literal("RAZBOR_MCP_TOKEN").default("RAZBOR_MCP_TOKEN"),
    startupMs: z.number().int().min(100).max(60000).default(15000),
    queryMs: z.number().int().min(100).max(60000).default(15000),
  })
  .strict();

export type PreparedMcpServer = z.infer<typeof preparedMcpServerSchema>;
