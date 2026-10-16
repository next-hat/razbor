import { z } from "zod";

export const publicIdPrefixes = {
  user: "usr",
  context: "ctx",
  invitation: "inv",
  agent: "agent",
  skill: "skl",
  mcpServer: "mcp",
  runner: "run",
  forge: "forge",
  githubApp: "ghapp",
  webhook: "hook",
  repository: "repo",
  pullRequest: "pr",
  review: "rev",
  attempt: "att",
  workspace: "idx",
  token: "tok",
  memoryCollection: "memcol",
  memory: "mem",
} as const;

export type ResourceKind = keyof typeof publicIdPrefixes;

/**
 * Build the anchored public identifier pattern shared by validation and
 * database constraints.
 */
export const publicIdPattern = (kind: ResourceKind) =>
  `^${publicIdPrefixes[kind]}_[A-Za-z0-9]{16}$`;

/**
 * Validate that an identifier has the requested resource prefix and random
 * suffix.
 */
export const publicIdSchema = (kind: ResourceKind) =>
  z.string().regex(new RegExp(publicIdPattern(kind)), "invalid public ID");
