import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  modelProviderSchema,
  reasoningEffortSchema,
  publicIdSchema,
  type ModelProvider,
  type ReasoningEffort,
  type ReviewAgentSnapshot,
} from "@razbor/contracts";

import { AuthInputError } from "@database/src/auth.js";
import {
  defaultImportContextId,
  requireContextSession,
  resolveContextId,
} from "@database/src/contexts.js";
import type { Database, Transaction } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import { agents, repositories, reviews } from "@database/src/schema.js";

export type AgentView = {
  id: string;
  provider: ModelProvider;
  endpoint: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export class AgentInputError extends Error {
  /**
   * Attach an API-safe validation or conflict status to a reviewer profile
   * error.
   */
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Detect ASCII control characters that cannot appear in saved endpoint, model
 * or credential values.
 */
function hasControlCharacters(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

const endpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (
      !/^https?:\/\//i.test(value) ||
      /[\s?#]/.test(value) ||
      hasControlCharacters(value)
    )
      return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        url.toString().length <= 2048
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).toString());

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !hasControlCharacters(value) && Buffer.byteLength(value, "utf8") <= 512,
  );

const apiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((value) => !hasControlCharacters(value));

const agentDetailsSchema = z
  .object({
    provider: modelProviderSchema.default("openai"),
    endpoint: endpointSchema,
    model: modelSchema,
    reasoningEffort: reasoningEffortSchema.default("high"),
    apiKey: apiKeySchema,
  })
  .strict();

/** Require the native API path selected by the saved provider. */
function hasProviderEndpoint(input: {
  provider: ModelProvider;
  endpoint: string;
}) {
  try {
    return new URL(input.endpoint).pathname.endsWith(
      input.provider === "anthropic" ? "/messages" : "/responses",
    );
  } catch {
    return false;
  }
}

const createAgentSchema = agentDetailsSchema.refine(hasProviderEndpoint, {
  path: ["endpoint"],
});

const updateAgentSchema = agentDetailsSchema
  .extend({
    apiKey: apiKeySchema.optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .refine(hasProviderEndpoint, { path: ["endpoint"] });

const inputMessages: Record<string, string> = {
  provider: "Provider must be OpenAI Responses or Anthropic Claude.",
  reasoningEffort: "Reasoning effort must be low, medium, or high.",
  endpoint:
    "Endpoint must be a full HTTP or HTTPS URL ending in /responses for OpenAI or /messages for Anthropic, without credentials, a query, or a fragment (maximum 2048 characters).",
  model:
    "Model is required and must be at most 256 characters (512 UTF-8 bytes) without control characters.",
  apiKey:
    "API key is required and must be at most 8192 characters without control characters.",
};

/**
 * Validate profile input and expose a field-specific message without including
 * submitted secrets.
 */
function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AgentInputError(
      400,
      inputMessages[String(result.error.issues[0]?.path[0])] ??
        "Invalid agent details. Use only provider, endpoint, model, reasoning effort, and API key.",
    );
  return result.data;
}

const viewSelection = {
  id: agents.publicId,
  provider: agents.provider,
  endpoint: agents.endpoint,
  model: agents.model,
  reasoningEffort: agents.reasoningEffort,
  hasApiKey: sql<boolean>`${agents.apiKey} <> ''`,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
};

/**
 * Serialize profile timestamps for API responses without exposing the saved
 * API key.
 */
function view(
  row: Omit<AgentView, "createdAt" | "updatedAt"> & {
    createdAt: Date;
    updatedAt: Date;
  },
): AgentView {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Translate duplicate profiles into a conflict and hide database error details
 * that may contain credentials.
 */
function persistenceError(error: unknown): never {
  if (error instanceof AgentInputError || error instanceof AuthInputError)
    throw error;
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const pg = cause as { code?: string; constraint?: string } | null;
  if (pg?.code === "23505" && pg.constraint === "agents_endpoint_model_unique")
    throw new AgentInputError(
      409,
      "This endpoint and model are already registered. Edit the existing agent to update its API key.",
    );
  // Database errors can contain bound API keys; never expose their cause.
  throw new Error("Unable to access saved agents.");
}

/**
 * Take a shared lock and snapshot an assigned profile's nonsecret identity and
 * version for a review; fail if its assignment is missing.
 */
export async function snapshotRepositoryAgent(
  tx: Transaction,
  id: string | null,
  contextInternalId?: string | null,
): Promise<ReviewAgentSnapshot | undefined> {
  if (!id) return undefined;
  const [agent] = await tx
    .select({
      id: agents.publicId,
      provider: agents.provider,
      endpoint: agents.endpoint,
      model: agents.model,
      reasoningEffort: agents.reasoningEffort,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.id, id),
        contextInternalId === undefined
          ? undefined
          : sql`${agents.contextId} is not distinct from ${contextInternalId}::uuid`,
      ),
    )
    .for("share");
  if (!agent) throw new Error("Assigned AI reviewer is unavailable.");
  return { ...agent, updatedAt: agent.updatedAt.toISOString() };
}

/**
 * List saved reviewer profiles in stable creation order, exposing credential
 * presence rather than values.
 */
export async function listAgents(
  database: Database,
  contextId?: string,
): Promise<AgentView[]> {
  try {
    const rows = await database.db
      .select(viewSelection)
      .from(agents)
      .where(
        contextId === undefined
          ? undefined
          : sql`${agents.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      )
      .orderBy(asc(agents.createdAt), asc(agents.publicId));
    return rows.map(view);
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Validate and persist a reviewer profile, returning its public representation
 * or a sanitized conflict.
 */
export async function createAgent(
  database: Database,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<AgentView> {
  const request = parseInput(createAgentSchema, input);
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "agents",
        );
      const ownerId =
        contextId === undefined
          ? await defaultImportContextId(tx)
          : await resolveContextId(tx, contextId);
      const [row] = await tx
        .insert(agents)
        .values({ ...request, contextId: ownerId, publicId: publicId("agent") })
        .returning(viewSelection);
      return view(row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Update a saved profile while preserving its API key when omitted; return
 * undefined for an invalid or missing ID.
 */
export async function updateAgent(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<AgentView | undefined> {
  if (!publicIdSchema("agent").safeParse(id).success) return undefined;
  const request = parseInput(updateAgentSchema, input);
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "agents",
        );
      const [row] = await tx
        .update(agents)
        .set({ ...request, updatedAt: new Date() })
        .where(
          and(
            eq(agents.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${agents.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .returning(viewSelection);
      return row ? view(row) : undefined;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Delete an unused profile under lock; reject removal while any repository
 * assignment or queued or running review still references it.
 */
export async function deleteAgent(
  database: Database,
  id: string,
  contextId?: string,
  sessionToken?: string,
): Promise<boolean> {
  if (!publicIdSchema("agent").safeParse(id).success) return false;
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "agents",
        );
      // Submission and assignment take a shared lock before referencing this agent.
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${agents.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .for("update");
      if (!agent) return false;
      const [repository] = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.agentId, agent.id))
        .limit(1);
      if (repository)
        throw new AgentInputError(
          409,
          "This AI reviewer is assigned to a repository. Change its assignment before deleting the reviewer.",
        );
      const [review] = await tx
        .select({ id: reviews.id })
        .from(reviews)
        .where(
          and(
            sql`${reviews.source}->'agent'->>'id' = ${id}`,
            sql`${reviews.status} in ('queued', 'running')`,
          ),
        )
        .limit(1);
      if (review)
        throw new AgentInputError(
          409,
          "This AI reviewer has queued or running reviews. Wait for them to finish before deleting it.",
        );
      await tx.delete(agents).where(eq(agents.id, agent.id));
      return true;
    });
  } catch (error) {
    return persistenceError(error);
  }
}
