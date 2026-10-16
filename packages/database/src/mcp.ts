import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  mcpServerInputSchema,
  mcpServerSnapshotSchema,
  publicIdSchema,
  repositoryMcpAccessSchema,
  type McpServerSnapshot,
  type McpServerView,
  type RepositoryMcpAccess,
} from "@razbor/contracts";

import { AuthInputError } from "@database/src/auth.js";
import {
  defaultImportContextId,
  requireContextSession,
  resolveContextId,
} from "@database/src/contexts.js";
import type { Database, Transaction } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import {
  mcpServers,
  repositories,
  repositoryMcpServers,
} from "@database/src/schema.js";

export class McpInputError extends Error {
  /** Expose a safe validation or conflict message without submitted credentials. */
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type McpServerConnection = McpServerSnapshot & {
  endpoint: string;
  token?: string;
};

const viewSelection = {
  id: mcpServers.publicId,
  name: mcpServers.name,
  endpoint: mcpServers.endpoint,
  enabled: mcpServers.enabled,
  hasToken: sql<boolean>`${mcpServers.token} <> ''`,
  createdAt: mcpServers.createdAt,
  updatedAt: mcpServers.updatedAt,
};

const connectionSelection = {
  id: mcpServers.publicId,
  name: mcpServers.name,
  endpoint: mcpServers.endpoint,
  token: mcpServers.token,
};

const inputMessages: Record<string, string> = {
  name: "Name must be a lowercase slug with at most 32 characters.",
  endpoint:
    "Endpoint must be a full HTTP or HTTPS URL without credentials or a fragment (maximum 2048 characters).",
  token: "Bearer token must be at most 8192 printable ASCII characters.",
  enabled: "Choose whether this MCP server is enabled.",
};

const updateMcpServerSchema = mcpServerInputSchema
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "Choose at least one MCP server setting.",
  );

/** Validate server details and return field messages without including input values. */
function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new McpInputError(
      400,
      inputMessages[String(result.error.issues[0]?.path[0])] ??
        "Invalid MCP details. Use only name, endpoint, token, and enabled.",
    );
  return result.data;
}

/** Serialize audit dates while preserving the redacted token-presence field. */
function view(
  row: Omit<McpServerView, "createdAt" | "updatedAt"> & {
    createdAt: Date;
    updatedAt: Date;
  },
): McpServerView {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Omit absent bearer tokens from broker-only connection details. */
function connection(
  row: McpServerSnapshot & { endpoint: string; token: string },
): McpServerConnection {
  const { token, ...details } = row;
  return token ? { ...details, token } : details;
}

/** Hide database details that can include bound tokens while identifying duplicate names. */
function persistenceError(error: unknown): never {
  if (error instanceof McpInputError || error instanceof AuthInputError)
    throw error;
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const pg = cause as { code?: string; constraint?: string } | null;
  if (pg?.code === "23505" && pg.constraint === "mcp_servers_name_unique")
    throw new McpInputError(
      409,
      "This MCP server name is already registered. Choose another name or edit the existing server.",
    );
  // Database errors can contain bearer tokens; do not propagate their causes.
  throw new Error("Unable to access saved MCP servers.");
}

/** List HTTP servers in the selected account without returning bearer token values. */
export async function listMcpServers(
  database: Database,
  contextId?: string,
): Promise<McpServerView[]> {
  try {
    const rows = await database.db
      .select(viewSelection)
      .from(mcpServers)
      .where(
        contextId === undefined
          ? undefined
          : sql`${mcpServers.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      )
      .orderBy(asc(mcpServers.createdAt), asc(mcpServers.publicId));
    return rows.map(view);
  } catch (error) {
    return persistenceError(error);
  }
}

/** Read a redacted registration in the selected account, returning undefined for absent IDs. */
export async function getMcpServer(
  database: Database,
  id: string,
  contextId?: string,
): Promise<McpServerView | undefined> {
  if (!publicIdSchema("mcpServer").safeParse(id).success) return undefined;
  try {
    const [row] = await database.db
      .select(viewSelection)
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.publicId, id),
          contextId === undefined
            ? undefined
            : sql`${mcpServers.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      );
    return row ? view(row) : undefined;
  } catch (error) {
    return persistenceError(error);
  }
}

/** Register an HTTP MCP server with no repository access until explicitly granted. */
export async function createMcpServer(
  database: Database,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<McpServerView> {
  const request = parseInput(mcpServerInputSchema, input);
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(tx, sessionToken, contextId ?? "", "mcp");
      const ownerId =
        contextId === undefined
          ? await defaultImportContextId(tx)
          : await resolveContextId(tx, contextId);
      const [row] = await tx
        .insert(mcpServers)
        .values({
          ...request,
          contextId: ownerId,
          token: request.token ?? "",
          publicId: publicId("mcpServer"),
        })
        .returning(viewSelection);
      return view(row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Update supplied settings, preserving omitted fields; empty tokens clear authentication. */
export async function updateMcpServer(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<McpServerView | undefined> {
  if (!publicIdSchema("mcpServer").safeParse(id).success) return undefined;
  const request = parseInput(updateMcpServerSchema, input);
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(tx, sessionToken, contextId ?? "", "mcp");
      const [row] = await tx
        .update(mcpServers)
        .set({ ...request, updatedAt: new Date() })
        .where(
          and(
            eq(mcpServers.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${mcpServers.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .returning(viewSelection);
      return row ? view(row) : undefined;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Delete an account registration and its repository grants through cascading foreign keys. */
export async function deleteMcpServer(
  database: Database,
  id: string,
  contextId?: string,
  sessionToken?: string,
): Promise<boolean> {
  if (!publicIdSchema("mcpServer").safeParse(id).success) return false;
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(tx, sessionToken, contextId ?? "", "mcp");
      const rows = await tx
        .delete(mcpServers)
        .where(
          and(
            eq(mcpServers.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${mcpServers.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .returning({ id: mcpServers.id });
      return rows.length > 0;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Read a repository's whole-server grants, including retained disabled registrations. */
export async function getRepositoryMcpAccess(
  database: Database,
  id: string,
  contextId?: string,
): Promise<RepositoryMcpAccess | undefined> {
  if (!publicIdSchema("repository").safeParse(id).success) return undefined;
  try {
    const rows = await database.db
      .select({ serverId: mcpServers.publicId })
      .from(repositories)
      .leftJoin(
        repositoryMcpServers,
        eq(repositoryMcpServers.repositoryId, repositories.id),
      )
      .leftJoin(
        mcpServers,
        and(
          eq(mcpServers.id, repositoryMcpServers.serverId),
          sql`${mcpServers.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .where(
        and(
          eq(repositories.publicId, id),
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      )
      .orderBy(asc(mcpServers.publicId));
    return rows.length
      ? {
          serverIds: rows.flatMap((row) =>
            row.serverId ? [row.serverId] : [],
          ),
        }
      : undefined;
  } catch (error) {
    return persistenceError(error);
  }
}

/** Replace grants under a repository lock after checking every server shares its account. */
export async function updateRepositoryMcpAccess(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<RepositoryMcpAccess | undefined> {
  if (!publicIdSchema("repository").safeParse(id).success) return undefined;
  const result = repositoryMcpAccessSchema.safeParse(input);
  if (!result.success)
    throw new McpInputError(
      400,
      "Choose at most 16 unique registered MCP servers.",
    );
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(tx, sessionToken, contextId ?? "", "mcp");
      const [repository] = await tx
        .select({
          id: repositories.id,
          status: repositories.status,
          contextId: repositories.contextId,
        })
        .from(repositories)
        .where(
          and(
            eq(repositories.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .for("update");
      if (!repository || repository.status !== "active") return undefined;
      const servers = result.data.serverIds.length
        ? await tx
            .select({ id: mcpServers.id, publicId: mcpServers.publicId })
            .from(mcpServers)
            .where(
              and(
                inArray(mcpServers.publicId, result.data.serverIds),
                sql`${mcpServers.contextId} is not distinct from ${repository.contextId}::uuid`,
              ),
            )
            .orderBy(asc(mcpServers.publicId))
            .for("share")
        : [];
      if (servers.length !== result.data.serverIds.length)
        throw new McpInputError(
          409,
          "A selected MCP server is unavailable. Refresh the server list and update the selection.",
        );
      await tx
        .delete(repositoryMcpServers)
        .where(eq(repositoryMcpServers.repositoryId, repository.id));
      if (servers.length)
        await tx.insert(repositoryMcpServers).values(
          servers.map((server) => ({
            repositoryId: repository.id,
            serverId: server.id,
          })),
        );
      await tx
        .update(repositories)
        .set({ updatedAt: new Date() })
        .where(eq(repositories.id, repository.id));
      return { serverIds: servers.map((server) => server.publicId) };
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Snapshot enabled granted identities for a review whose repository is already locked. */
export async function snapshotRepositoryMcpServers(
  tx: Transaction,
  repositoryInternalId: string,
): Promise<McpServerSnapshot[]> {
  try {
    const rows = await tx
      .select({ id: mcpServers.publicId, name: mcpServers.name })
      .from(repositoryMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, repositoryMcpServers.serverId))
      .innerJoin(
        repositories,
        eq(repositories.id, repositoryMcpServers.repositoryId),
      )
      .where(
        and(
          eq(repositoryMcpServers.repositoryId, repositoryInternalId),
          eq(mcpServers.enabled, true),
          sql`${mcpServers.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .orderBy(asc(mcpServers.publicId))
      .for("share", { of: mcpServers });
    return rows.map((row) => mcpServerSnapshotSchema.parse(row));
  } catch (error) {
    return persistenceError(error);
  }
}

/** Read current credentials for a connection check, including disabled registrations. */
export async function getMcpServerConnection(
  database: Database,
  id: string,
  contextId?: string,
): Promise<McpServerConnection | undefined> {
  if (!publicIdSchema("mcpServer").safeParse(id).success) return undefined;
  try {
    const [row] = await database.db
      .select(connectionSelection)
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.publicId, id),
          contextId === undefined
            ? undefined
            : sql`${mcpServers.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      );
    return row ? connection(row) : undefined;
  } catch (error) {
    return persistenceError(error);
  }
}

/** Resolve broker credentials only while a live repository grant and enabled server remain. */
export async function resolveRepositoryMcpServer(
  database: Database,
  repositoryPublicId: string,
  serverPublicId: string,
): Promise<McpServerConnection | undefined> {
  if (
    !publicIdSchema("repository").safeParse(repositoryPublicId).success ||
    !publicIdSchema("mcpServer").safeParse(serverPublicId).success
  )
    return undefined;
  try {
    const [row] = await database.db
      .select(connectionSelection)
      .from(repositoryMcpServers)
      .innerJoin(
        repositories,
        eq(repositories.id, repositoryMcpServers.repositoryId),
      )
      .innerJoin(mcpServers, eq(mcpServers.id, repositoryMcpServers.serverId))
      .where(
        and(
          eq(repositories.publicId, repositoryPublicId),
          eq(repositories.status, "active"),
          eq(mcpServers.publicId, serverPublicId),
          eq(mcpServers.enabled, true),
          sql`${mcpServers.contextId} is not distinct from ${repositories.contextId}`,
        ),
      );
    return row ? connection(row) : undefined;
  } catch (error) {
    return persistenceError(error);
  }
}
