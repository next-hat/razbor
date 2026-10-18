import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parse } from "smol-toml";

import {
  publicIdSchema,
  githubInstallationSchema,
  type GithubInstallation,
} from "@razbor/contracts";
import {
  identifier,
  absolute,
  repositoryConfigSchema,
} from "@razbor/harness/git-policy";
import {
  approvedUrl,
  ForgeReadError,
  verifyRegistration,
  verifyRepository,
} from "@razbor/forge-adapters";

import {
  AgentInputError,
  snapshotRepositoryAgent,
} from "@database/src/agents.js";
import {
  defaultImportContextId,
  requireContextSession,
  resolveContextId,
} from "@database/src/contexts.js";
import { webhookSettingsSchema } from "@database/src/webhook-settings.js";
import type { Database, Transaction } from "@database/src/connection.js";
import {
  agents,
  forgeInstances,
  githubApps,
  repositories,
  repositoryWebhooks,
  reviews,
  storedSecrets,
  type SecretReference,
} from "@database/src/schema.js";
import { publicId } from "@database/src/ids.js";
import { readStoredSecret } from "@database/src/secrets.js";
import { reviewCommandText } from "@database/src/presentation.js";
import {
  githubInstallationAccess,
  resolveGithubInstallationToken,
  readGithubAppWebhookSecret,
} from "@database/src/github-apps.js";

export const secretReferenceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
  z.object({ file: absolute }).strict(),
  z.object({ stored: z.string().uuid() }).strict(),
  z.object({ github_app: githubInstallationSchema }).strict(),
  z.object({ githubApp: publicIdSchema("githubApp") }).strict(),
]);

export const registrySchema = z
  .object({
    registry: z.object({ key: identifier }).strict(),
    forges: z
      .record(
        identifier,
        z
          .object({
            type: z.enum(["github", "gitlab", "forgejo"]),
            api_url: z.string(),
            web_url: z.string(),
            credential: secretReferenceSchema.optional(),
            allow_http: z.boolean().default(false),
          })
          .strict(),
      )
      .default({}),
    repositories: z.record(
      identifier,
      z
        .object({
          webhook: webhookSettingsSchema.optional(),
          forge: identifier.optional(),
          selector: z.string().min(1).max(1024).optional(),
          git: repositoryConfigSchema,
          indexing: z
            .object({
              owner: identifier,
              persistent: z.boolean().default(true),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const forge of Object.values(value.forges)) {
      try {
        approvedUrl(forge.api_url, forge.allow_http);
        approvedUrl(forge.web_url, forge.allow_http);
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "forge URLs require HTTPS, or explicit allow_http for development",
        });
      }
    }
    for (const repo of Object.values(value.repositories)) {
      if (
        !!repo.forge !== !!repo.selector ||
        (repo.forge && !Object.hasOwn(value.forges, repo.forge))
      )
        ctx.addIssue({
          code: "custom",
          message:
            "repository forge and selector must reference a declared instance together",
        });
    }
  });

export type RegistryConfig = z.infer<typeof registrySchema>;

/**
 * Read TOML registry configuration and validate declared forge, repository and
 * secret references.
 */
export async function loadRegistry(file: string) {
  return registrySchema.parse(parse(await readFile(file, "utf8")));
}

/**
 * Resolve static credentials or fresh GitHub installation access. App signing
 * secrets remain server-side; static credentials reject line or NUL delimiters.
 */
export async function readSecret(ref: SecretReference, database?: Database) {
  if ("github_app" in ref || "githubApp" in ref) {
    if (!database) throw new Error("GitHub App credentials unavailable");
    return "github_app" in ref
      ? resolveGithubInstallationToken(database, ref.github_app)
      : readGithubAppWebhookSecret(database, ref.githubApp);
  }
  if ("stored" in ref) {
    if (!database) throw new Error("stored credential unavailable");
    return readStoredSecret(database, ref.stored);
  }
  const value =
    "env" in ref
      ? process.env[ref.env]
      : (await readFile(ref.file, "utf8")).trimEnd();
  if (!value || /[\r\n\0]/.test(value))
    throw new Error("missing or invalid secret reference");
  return value;
}

export class RegistryConflict extends Error {
  /**
   * Report registry ownership or repository identity conflicts without
   * exposing database details.
   */
  constructor() {
    super("registry ownership or repository identity conflict");
  }
}

/** Reject imported stored or App credentials belonging to another account context. */
async function validateImportCredentialContext(
  tx: Transaction,
  contextId: string | null,
  reference?: SecretReference | null,
): Promise<void> {
  if (!reference) return;
  const appId =
    "github_app" in reference
      ? reference.github_app.app_id
      : "githubApp" in reference
        ? reference.githubApp
        : undefined;
  if (appId) {
    const [app] = await tx
      .select({ id: githubApps.id })
      .from(githubApps)
      .where(
        and(
          eq(githubApps.publicId, appId),
          sql`${githubApps.contextId} is not distinct from ${contextId}::uuid`,
        ),
      )
      .for("share");
    if (!app) throw new RegistryConflict();
  } else if ("stored" in reference) {
    const [secret] = await tx
      .select({ id: storedSecrets.id })
      .from(storedSecrets)
      .innerJoin(repositories, eq(storedSecrets.repositoryId, repositories.id))
      .where(
        and(
          eq(storedSecrets.id, reference.stored),
          sql`${repositories.contextId} is not distinct from ${contextId}::uuid`,
        ),
      )
      .for("share", { of: storedSecrets });
    if (!secret) throw new RegistryConflict();
  }
}

/**
 * Apply declared forge and repository settings under the registry lock,
 * preserving ownership and identity; changed source policies invalidate
 * verification without deleting absent entries.
 */
export async function applyRegistry(database: Database, input: RegistryConfig) {
  const config = registrySchema.parse(input);
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(748321, 2)`);
    const managedBy = config.registry.key;
    const importContextId = await defaultImportContextId(tx);
    const forgeIds = new Map<
      string,
      { id: string; contextId: string | null }
    >();
    for (const [key, f] of Object.entries(config.forges)) {
      const candidates = await tx
        .select()
        .from(forgeInstances)
        .where(eq(forgeInstances.configKey, key))
        .for("update");
      if (candidates.length > 1) throw new RegistryConflict();
      const [existing] = candidates;
      if (
        existing &&
        (existing.managedBy !== managedBy ||
          existing.type !== f.type ||
          existing.apiUrl !== f.api_url ||
          existing.webUrl !== f.web_url)
      )
        throw new RegistryConflict();
      const ownerId = existing ? existing.contextId : importContextId;
      await validateImportCredentialContext(tx, ownerId, f.credential);
      const values = {
        managedBy,
        configKey: key,
        type: f.type,
        apiUrl: f.api_url,
        webUrl: f.web_url,
        credential: f.credential ?? null,
        allowHttp: f.allow_http,
      };
      const [row] = existing
        ? await tx
            .update(forgeInstances)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(forgeInstances.id, existing.id))
            .returning()
        : await tx
            .insert(forgeInstances)
            .values({
              ...values,
              contextId: importContextId,
              publicId: publicId("forge"),
            })
            .returning();
      forgeIds.set(key, { id: row.id, contextId: row.contextId });
    }
    for (const [key, r] of Object.entries(config.repositories)) {
      const candidates = await tx
        .select()
        .from(repositories)
        .where(eq(repositories.configKey, key))
        .for("update");
      if (candidates.length > 1) throw new RegistryConflict();
      const [existing] = candidates;
      const boundForge = r.forge ? forgeIds.get(r.forge)! : null;
      const forgeId = boundForge?.id ?? null;
      const ownerId = existing
        ? existing.contextId
        : boundForge
          ? boundForge.contextId
          : importContextId;
      if (boundForge && boundForge.contextId !== ownerId)
        throw new RegistryConflict();
      if (r.git.credentials?.kind === "https")
        await validateImportCredentialContext(
          tx,
          ownerId,
          r.git.credentials.github_app
            ? { github_app: r.git.credentials.github_app }
            : r.git.credentials.token_id
              ? { stored: r.git.credentials.token_id }
              : undefined,
        );
      if (
        existing &&
        (existing.status !== "active" ||
          existing.managedBy !== managedBy ||
          existing.forgeId !== forgeId ||
          existing.indexOwner !== r.indexing.owner)
      )
        throw new RegistryConflict();
      // A declared path may change; verification must still resolve the bound external ID.
      const values = {
        managedBy,
        configKey: key,
        forgeId,
        selector: r.selector ?? null,
        git: r.git,
        indexOwner: r.indexing.owner,
        persistent: r.indexing.persistent,
      };
      if (!existing)
        await tx.insert(repositories).values({
          ...values,
          contextId: ownerId,
          publicId: publicId("repository"),
        });
      else if (
        !isDeepStrictEqual(
          {
            git: existing.git,
            selector: existing.selector,
            persistent: existing.persistent,
          },
          {
            git: r.git,
            selector: r.selector ?? null,
            persistent: r.indexing.persistent,
          },
        )
      )
        await tx
          .update(repositories)
          .set({
            ...values,
            version: existing.version + 1,
            verifiedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(repositories.id, existing.id));
    }
  });
}

export const repositorySelection = {
  publicId: repositories.publicId,
  configKey: repositories.configKey,
  forgePublicId: forgeInstances.publicId,
  forgeType: forgeInstances.type,
  agentId: agents.publicId,
  agent: {
    id: agents.publicId,
    endpoint: agents.endpoint,
    model: agents.model,
  },
  selector: repositories.selector,
  externalRepositoryId: repositories.externalRepositoryId,
  observed: repositories.observed,
  persistent: repositories.persistent,
  verifiedAt: repositories.verifiedAt,
  branch: sql<string>`${repositories.git}->>'branch'`,
  status: repositories.status,
  setupState: repositories.setupState,
  setupError: repositories.setupError,
  connectionMode: sql<
    "managed" | "manual" | "github-app"
  >`coalesce((select mode from repository_webhooks where repository_id = ${repositories.id}), 'managed')`,
};

/**
 * Build a public repository view with approved metadata and assigned reviewer
 * details, excluding credentials and internal IDs.
 */
function repositoryView(row: {
  publicId: string;
  configKey: string;
  forgePublicId: string | null;
  forgeType: "github" | "gitlab" | "forgejo" | null;
  agentId: string | null;
  agent: { id: string; endpoint: string; model: string } | null;
  selector: string | null;
  externalRepositoryId: string | null;
  observed: typeof repositories.$inferSelect.observed;
  persistent: boolean;
  verifiedAt: Date | null;
  branch: string;
  status: "active" | "deleting";
  setupState: "pending" | "indexing" | "ready" | "error";
  setupError: string | null;
  connectionMode: "managed" | "manual" | "github-app";
}) {
  return {
    id: row.publicId,
    configKey: row.configKey,
    forgeId: row.forgePublicId,
    forgeType: row.forgeType,
    agentId: row.agentId,
    agent: row.agent,
    selector: row.selector,
    externalRepositoryId: row.externalRepositoryId,
    metadata: row.observed
      ? {
          externalRepositoryId: row.observed.externalRepositoryId,
          fullPath: row.observed.fullPath,
          webUrl: row.observed.webUrl,
          defaultBranch: row.observed.defaultBranch,
          visibility: row.observed.visibility,
          archived: row.observed.archived,
        }
      : null,
    persistent: row.persistent,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    branch: row.branch,
    status: row.status,
    setupState: row.setupState,
    setupError: row.setupError,
    connectionMode: row.connectionMode,
    reviewCommand: reviewCommandText(),
  };
}

/**
 * List up to one hundred registered repositories in configuration-key order
 * with their assigned reviewer metadata. An optional access-grant list scopes
 * the query before the limit, and an empty grant list returns no repositories.
 */
export async function listRepositories(
  database: Database,
  repositoryIds?: string[],
  contextId?: string,
) {
  repositoryIds?.forEach((id) => publicIdSchema("repository").parse(id));
  return (
    await database.db
      .select(repositorySelection)
      .from(repositories)
      .leftJoin(
        forgeInstances,
        and(
          eq(repositories.forgeId, forgeInstances.id),
          sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .leftJoin(
        agents,
        and(
          eq(repositories.agentId, agents.id),
          sql`${agents.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .where(
        and(
          repositoryIds !== undefined
            ? inArray(repositories.publicId, repositoryIds)
            : undefined,
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      )
      .orderBy(repositories.configKey)
      .limit(100)
  ).map(repositoryView);
}

/**
 * Resolve a public repository ID to its management view, returning undefined
 * when absent.
 */
export async function getRepository(
  database: Database,
  id: string,
  contextId?: string,
) {
  publicIdSchema("repository").parse(id);
  const [row] = await database.db
    .select(repositorySelection)
    .from(repositories)
    .leftJoin(
      forgeInstances,
      and(
        eq(repositories.forgeId, forgeInstances.id),
        sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
      ),
    )
    .leftJoin(
      agents,
      and(
        eq(repositories.agentId, agents.id),
        sql`${agents.contextId} is not distinct from ${repositories.contextId}`,
      ),
    )
    .where(
      and(
        eq(repositories.publicId, id),
        contextId === undefined
          ? undefined
          : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      ),
    );
  return row ? repositoryView(row) : undefined;
}

/**
 * Assign or clear a reviewer profile for future submissions and fill missing
 * snapshots on queued reviews. Keep existing snapshots and running reviews pinned.
 */
export async function assignRepositoryAgent(
  database: Database,
  repositoryId: string,
  agentId: string | null,
  contextId?: string,
  sessionToken?: string,
) {
  if (!publicIdSchema("repository").safeParse(repositoryId).success)
    return undefined;
  if (agentId !== null && !publicIdSchema("agent").safeParse(agentId).success)
    throw new AgentInputError(400, "Select a saved AI reviewer.");
  return database.transaction(async (tx) => {
    if (sessionToken !== undefined)
      await requireContextSession(
        tx,
        sessionToken,
        contextId ?? "",
        "repositories",
      );
    const [repository] = await tx
      .select({
        id: repositories.id,
        status: repositories.status,
        contextId: repositories.contextId,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.publicId, repositoryId),
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      )
      .for("update");
    if (!repository) return undefined;
    if (repository.status !== "active")
      throw new AgentInputError(409, "This repository is being deleted.");
    let savedAgentId: string | null = null;
    if (agentId !== null) {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.publicId, agentId),
            sql`${agents.contextId} is not distinct from ${repository.contextId}::uuid`,
          ),
        )
        .for("share");
      if (!agent)
        throw new AgentInputError(
          400,
          "The selected AI reviewer is unavailable.",
        );
      savedAgentId = agent.id;
    }
    await tx
      .update(repositories)
      .set({ agentId: savedAgentId, updatedAt: new Date() })
      .where(eq(repositories.id, repository.id));
    const snapshot = await snapshotRepositoryAgent(
      tx,
      savedAgentId,
      repository.contextId,
    );
    if (snapshot) {
      // Conditional row updates serialize with attempt reservation without
      // replacing a pinned agent or changing an attempt that already started.
      await tx
        .update(reviews)
        .set({
          source: sql`jsonb_set(${reviews.source}, '{agent}', ${JSON.stringify(snapshot)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reviews.repositoryId, repository.id),
            eq(reviews.status, "queued"),
            sql`${reviews.source}->'agent' is null`,
          ),
        );
    }
    const [row] = await tx
      .select(repositorySelection)
      .from(repositories)
      .leftJoin(
        forgeInstances,
        and(
          eq(repositories.forgeId, forgeInstances.id),
          sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .leftJoin(
        agents,
        and(
          eq(repositories.agentId, agents.id),
          sql`${agents.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .where(eq(repositories.id, repository.id));
    return repositoryView(row);
  });
}

/** Resolve an active repository by public ID or an unambiguous configuration key. */
export async function resolveRepository(database: Database, key: string) {
  if (publicIdSchema("repository").safeParse(key).success) {
    const repository = await getRepository(database, key);
    return repository?.status === "active" ? repository.id : undefined;
  }
  const rows = await database.db
    .select({ publicId: repositories.publicId })
    .from(repositories)
    .where(
      and(eq(repositories.configKey, key), eq(repositories.status, "active")),
    )
    .limit(2);
  return rows.length === 1 ? rows[0].publicId : undefined;
}

/**
 * Fetch hosted metadata and publish it only if repository version, forge
 * settings and bound external identity still agree.
 */
export async function refreshRepository(database: Database, id: string) {
  publicIdSchema("repository").parse(id);
  const [before] = await database.db
    .select({ repository: repositories, forge: forgeInstances })
    .from(repositories)
    .innerJoin(
      forgeInstances,
      and(
        eq(repositories.forgeId, forgeInstances.id),
        sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
      ),
    )
    .where(eq(repositories.publicId, id));
  if (before?.repository.status !== "active")
    throw new Error("hosted repository unavailable");
  const f = before.forge;
  const credential = before.repository.apiCredential ?? f.credential;
  const metadata = await verifyRepository(
    {
      type: f.type,
      apiUrl: f.apiUrl,
      webUrl: f.webUrl,
      allowHttp: f.allowHttp,
      token: credential ? await readSecret(credential, database) : undefined,
    },
    before.repository.selector!,
  );
  await database.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.publicId, id))
      .for("update");
    if (
      current?.status !== "active" ||
      current.version !== before.repository.version ||
      (current.externalRepositoryId &&
        current.externalRepositoryId !== metadata.externalRepositoryId)
    )
      throw new RegistryConflict();
    const [forge] = await tx
      .select()
      .from(forgeInstances)
      .where(eq(forgeInstances.id, f.id))
      .for("share");
    if (forge.updatedAt.getTime() !== f.updatedAt.getTime())
      throw new RegistryConflict();
    await tx
      .update(repositories)
      .set({
        externalRepositoryId: metadata.externalRepositoryId,
        observed: metadata,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repositories.id, current.id),
          eq(repositories.version, current.version),
        ),
      );
  });
  return getRepository(database, id);
}

// A UI connection reuses an existing repository's server-owned transport and
// secret references. The browser can choose a project path, never credential
// paths, another Git host, or an arbitrary indexer owner.
/**
 * Recognize a reusable SSH or HTTPS remote whose path ends in the registered
 * selector, preserving its server-owned transport prefix.
 */
function connectionRemote(repo: typeof repositories.$inferSelect) {
  const name = repo.git.upstream.split("/")[2];
  const remote = new URL(repo.git.remotes[name]);
  const selector = repo.observed?.fullPath ?? repo.selector;
  if (!selector || !["ssh:", "https:"].includes(remote.protocol)) return;
  const suffix = remote.pathname.endsWith(".git") ? ".git" : "";
  const ending = `/${selector}${suffix}`;
  if (!decodeURIComponent(remote.pathname).endsWith(ending)) return;
  return {
    remote,
    suffix,
    prefix: decodeURIComponent(remote.pathname).slice(0, -ending.length),
  };
}

/**
 * List active repositories that can supply an existing transport connection,
 * exposing only display and transport metadata.
 */
export async function repositoryConnections(
  database: Database,
  contextId?: string,
) {
  const rows = await database.db
    .select({ repo: repositories, forge: forgeInstances })
    .from(repositories)
    .innerJoin(
      forgeInstances,
      and(
        eq(repositories.forgeId, forgeInstances.id),
        sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
      ),
    )
    .where(
      contextId === undefined
        ? undefined
        : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
    )
    .orderBy(repositories.configKey)
    .limit(100);
  return rows
    .filter(({ repo }) => repo.status === "active" && connectionRemote(repo))
    .map(({ repo, forge }) => ({
      id: repo.publicId,
      name: `${forge.configKey} · ${repo.observed?.fullPath ?? repo.selector}`,
      host: new URL(forge.webUrl).host,
      transport: connectionRemote(repo)!.remote.protocol.slice(0, -1),
    }));
}

const verifyRepositorySchema = z
  .object({
    forgeType: z.enum(["github", "gitlab", "forgejo"]).default("forgejo"),
    repositoryUrl: z.string().trim().url().max(2048),
    instanceUrl: z.string().trim().url().max(2048).optional(),
    accessToken: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .regex(/^[^\s\0]+$/)
      .optional(),
    githubAppId: publicIdSchema("githubApp").optional(),
    installationId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional(),
    githubRepositoryId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional(),
    branch: z.string().trim().max(200).optional(),
  })
  .strict();

const createRepositorySchema = verifyRepositorySchema.extend({
  agentId: publicIdSchema("agent").nullable().optional(),
  callbackBase: webhookSettingsSchema.shape.callback_base.optional(),
  permittedSenders: webhookSettingsSchema.shape.permitted_senders,
  webhookMode: z.enum(["managed", "manual"]).optional(),
});

export class RepositoryRegistrationError extends Error {
  /**
   * Carry an API-safe registration category, status and explanation for the
   * UI.
   */
  constructor(
    readonly code:
      | "invalid-url"
      | "connection"
      | "duplicate"
      | "invalid-branch"
      | "invalid-senders",
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve a credential-free HTTPS repository URL within its forge instance.
 * GitLab namespace segments remain part of its selector; an explicit instance
 * URL disambiguates an installation prefix from a namespace. Legacy Forgejo
 * registrations infer that prefix from the final owner/repository pair.
 */
function registrationLocation(
  value: string,
  type: "github" | "gitlab" | "forgejo",
  instanceUrl?: string,
) {
  const url = new URL(value);
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length < 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
    )
  )
    throw new RepositoryRegistrationError(
      "invalid-url",
      400,
      "Enter an HTTPS repository URL without credentials, query, or fragment.",
    );
  parts[parts.length - 1] = parts.at(-1)!.replace(/\.git$/, "");
  if (!parts.at(-1))
    throw new RepositoryRegistrationError(
      "invalid-url",
      400,
      "Repository name is required.",
    );
  let prefixParts: string[] = [];
  if (instanceUrl) {
    const instance = new URL(instanceUrl);
    prefixParts = instance.pathname.replace(/\/$/, "").split("/").slice(1);
    if (prefixParts.length === 1 && !prefixParts[0]) prefixParts = [];
    if (
      instance.origin !== url.origin ||
      instance.protocol !== "https:" ||
      instance.username ||
      instance.password ||
      instance.search ||
      instance.hash ||
      prefixParts.some(
        (part, index) =>
          !/^[A-Za-z0-9_.-]+$/.test(part) || parts[index] !== part,
      )
    )
      throw new RepositoryRegistrationError(
        "invalid-url",
        400,
        "The instance URL must be the HTTPS base URL containing this repository.",
      );
  } else if (type === "forgejo") {
    prefixParts = parts.slice(0, -2);
  }
  // Only canonical cloud hosts may move API requests to a different origin.
  const githubCloudApi =
    type !== "github" || url.port
      ? undefined
      : url.hostname === "github.com"
        ? "https://api.github.com"
        : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(url.hostname)
          ? `https://api.${url.hostname}`
          : undefined;
  const selectorParts = parts.slice(prefixParts.length);
  if (
    selectorParts.length < 2 ||
    (type !== "gitlab" && selectorParts.length !== 2) ||
    (type === "github" &&
      (url.hostname === "github.com" || githubCloudApi) &&
      prefixParts.length)
  )
    throw new RepositoryRegistrationError(
      "invalid-url",
      400,
      "Enter the repository page URL and, for an installation under a path, its instance URL.",
    );
  const prefix = prefixParts.length ? `/${prefixParts.join("/")}` : "";
  const webUrl = `${url.origin}${prefix}`;
  return {
    selector: selectorParts.join("/"),
    apiUrl:
      githubCloudApi ??
      `${webUrl}/api/${type === "github" ? "v3" : type === "gitlab" ? "v4" : "v1"}`,
    webUrl,
  };
}

/**
 * Normalize forge URL serialization and remove one trailing slash for identity
 * comparisons.
 */
function normalizedForgeUrl(value: string) {
  return new URL(value).href.replace(/\/$/, "");
}

/**
 * Verify provider identity, repository and branch using the same URL rules and
 * API-safe failures for both the access check and final registration.
 */
async function verifyUiRegistration(
  request: z.infer<typeof verifyRepositorySchema>,
  database?: Database,
  contextId?: string,
) {
  const hasApp = !!request.githubAppId;
  if (
    (hasApp &&
      (request.forgeType !== "github" ||
        !request.installationId ||
        !request.githubRepositoryId ||
        request.accessToken)) ||
    (!hasApp &&
      (!request.accessToken ||
        request.installationId ||
        request.githubRepositoryId))
  )
    throw new RepositoryRegistrationError(
      "connection",
      400,
      "Choose a GitHub App installation or provide a bot access token.",
    );
  const installation: GithubInstallation | undefined = hasApp
    ? {
        app_id: request.githubAppId!,
        installation_id: request.installationId!,
        repository_id: request.githubRepositoryId!,
      }
    : undefined;
  const appAccess =
    installation && database
      ? await githubInstallationAccess(database, installation, contextId)
      : undefined;
  if (hasApp && !appAccess)
    throw new RepositoryRegistrationError(
      "connection",
      400,
      "GitHub App unavailable.",
    );
  const location = registrationLocation(
    request.repositoryUrl,
    request.forgeType,
    appAccess?.app.webUrl ?? request.instanceUrl,
  );
  let verified;
  try {
    verified = await verifyRegistration(
      {
        type: request.forgeType,
        ...location,
        allowHttp: false,
        token: request.accessToken,
        ...(appAccess?.connection ?? {}),
      },
      location.selector,
      request.branch,
    );
  } catch (error) {
    let message =
      "Unable to verify this repository. Check the selected forge, HTTPS URL, instance URL, token permissions, availability, and that it is not archived.";
    if (error instanceof ForgeReadError) {
      if (error.reason === "unauthorized") {
        message =
          "Repository access was denied. Check the selected connection and its repository read and review/comment write permissions.";
      } else if (error.reason === "not-found") {
        message =
          "Repository or branch was not found. Check the URL, branch, and bot access.";
      }
    }
    throw new RepositoryRegistrationError("connection", 400, message);
  }
  if (
    installation &&
    verified.metadata.externalRepositoryId !== installation.repository_id
  )
    throw new RepositoryRegistrationError(
      "connection",
      400,
      "The selected repository does not belong to this GitHub App connection.",
    );
  return { location, verified, installation, app: appAccess?.app };
}

/**
 * Check repository access without saving credentials or changing the forge.
 * Return only metadata needed by the connection form, excluding provider IDs,
 * tokens and clone credentials. This does not prove every write permission.
 */
export async function verifyRepositoryFromUi(
  input: unknown,
  database?: Database,
  contextId?: string,
) {
  const request = verifyRepositorySchema.parse(input);
  const { verified } = await verifyUiRegistration(request, database, contextId);
  return {
    fullPath: verified.metadata.fullPath,
    webUrl: verified.metadata.webUrl,
    visibility: verified.metadata.visibility,
    branch: verified.branch,
    botLogin: verified.identity.login,
  };
}

/**
 * Recheck selected forge access, branch and sender policy, then atomically
 * register the repository, reviewer and connection mode while rejecting duplicates.
 * App repositories persist installation references, never temporary tokens.
 * Return a per-repository signing secret only for token-based connections.
 */
export async function createRepositoryFromUi(
  database: Database,
  input: unknown,
  sessionToken?: string,
  contextId?: string,
) {
  const request = createRepositorySchema.parse(input);
  const { location, verified, installation, app } = await verifyUiRegistration(
    request,
    database,
    contextId,
  );
  if (request.webhookMode === "manual" && request.forgeType !== "github")
    throw new RepositoryRegistrationError(
      "connection",
      400,
      "Manual setup is available for GitHub repositories.",
    );
  const callbackBase = webhookSettingsSchema.shape.callback_base
    .parse(app?.callbackBase ?? request.callbackBase)
    .replace(/\/$/, "");
  const webhookMode = app ? "github-app" : (request.webhookMode ?? "managed");
  const { metadata, identity, branch, cloneUrl, gitUsername } = verified;
  if (
    metadata.visibility !== "private" &&
    request.permittedSenders.includes("*")
  )
    throw new RepositoryRegistrationError(
      "invalid-senders",
      400,
      "Public repositories require explicit reviewer usernames.",
    );
  const tokenId = randomUUID();
  const signingSecretId = randomUUID();
  const generatedSecret = app ? undefined : randomBytes(32).toString("hex");
  const parsedGit = repositoryConfigSchema.safeParse({
    branch,
    upstream: `refs/remotes/origin/${branch}`,
    remotes: { origin: cloneUrl },
    credentials: {
      kind: "https",
      username: gitUsername ?? identity.login,
      ...(installation ? { github_app: installation } : { token_id: tokenId }),
    },
  });
  if (!parsedGit.success)
    throw new RepositoryRegistrationError(
      "invalid-branch",
      400,
      "The selected branch is not a supported Git branch.",
    );
  const indexOwner = identifier.parse(
    process.env.RAZBOR_INDEX_OWNER || "local-indexer",
  );
  const result = await database.transaction(async (tx) => {
    if (sessionToken !== undefined)
      await requireContextSession(
        tx,
        sessionToken,
        contextId ?? "",
        "repositories",
      );
    const ownerId =
      contextId === undefined
        ? await defaultImportContextId(tx)
        : await resolveContextId(tx, contextId);
    if (app && app.contextId !== ownerId)
      throw new RepositoryRegistrationError(
        "connection",
        400,
        "The selected GitHub App is unavailable in this account.",
      );
    await tx.execute(sql`select pg_advisory_xact_lock(748321, 2)`);
    let agentId: string | null = null;
    if (request.agentId) {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.publicId, request.agentId),
            sql`${agents.contextId} is not distinct from ${ownerId}::uuid`,
          ),
        )
        .for("share");
      if (!agent)
        throw new AgentInputError(
          400,
          "The selected AI reviewer is unavailable.",
        );
      agentId = agent.id;
    }
    const instances = await tx
      .select()
      .from(forgeInstances)
      .where(
        and(
          eq(forgeInstances.type, request.forgeType),
          sql`${forgeInstances.contextId} is not distinct from ${ownerId}::uuid`,
        ),
      );
    const matching = instances.filter(
      (forge) =>
        normalizedForgeUrl(forge.apiUrl) ===
          normalizedForgeUrl(location.apiUrl) &&
        normalizedForgeUrl(forge.webUrl) ===
          normalizedForgeUrl(location.webUrl),
    );
    // Compare across duplicate legacy forge instances and unverified imports.
    // A legacy registration with only a matching selector still owns this repo.
    const registered = await tx
      .select({ repo: repositories, forge: forgeInstances })
      .from(repositories)
      .innerJoin(
        forgeInstances,
        and(
          eq(repositories.forgeId, forgeInstances.id),
          sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .where(
        and(
          eq(forgeInstances.type, request.forgeType),
          sql`${forgeInstances.contextId} is not distinct from ${ownerId}::uuid`,
        ),
      );
    const existing = registered.find(
      ({ repo, forge }) =>
        matching.some((candidate) => candidate.id === forge.id) &&
        (repo.externalRepositoryId === metadata.externalRepositoryId ||
          repo.selector?.toLowerCase() === metadata.fullPath.toLowerCase() ||
          repo.observed?.fullPath.toLowerCase() ===
            metadata.fullPath.toLowerCase()),
    );
    if (existing)
      throw new RepositoryRegistrationError(
        "duplicate",
        409,
        existing.repo.status === "deleting"
          ? "This repository is being deleted. Wait for cleanup before adding it again."
          : "This repository is already registered.",
      );
    let forge = matching[0];
    if (!forge) {
      const forgePublicId = publicId("forge");
      [forge] = await tx
        .insert(forgeInstances)
        .values({
          publicId: forgePublicId,
          contextId: ownerId,
          configKey: `ui-${forgePublicId}`,
          managedBy: "ui",
          type: request.forgeType,
          apiUrl: location.apiUrl,
          webUrl: location.webUrl,
          allowHttp: false,
        })
        .returning();
    }
    const repositoryPublicId = publicId("repository");
    const [repository] = await tx
      .insert(repositories)
      .values({
        publicId: repositoryPublicId,
        contextId: ownerId,
        configKey: `ui-${repositoryPublicId}`,
        managedBy: "ui",
        forgeId: forge.id,
        agentId,
        selector: metadata.fullPath,
        externalRepositoryId: metadata.externalRepositoryId,
        observed: metadata,
        verifiedAt: new Date(),
        git: parsedGit.data,
        apiCredential: installation
          ? { github_app: installation }
          : { stored: tokenId },
        indexOwner,
        persistent: true,
        setupState: "pending",
      })
      .returning();
    if (!app)
      await tx.insert(storedSecrets).values([
        {
          id: tokenId,
          repositoryId: repository.id,
          value: request.accessToken!,
        },
        {
          id: signingSecretId,
          repositoryId: repository.id,
          value: generatedSecret!,
        },
      ]);
    await tx.insert(repositoryWebhooks).values({
      publicId: publicId("webhook"),
      repositoryId: repository.id,
      managedBy: "ui",
      mode: webhookMode,
      enabled: true,
      callbackBase,
      secret: app ? { githubApp: app.publicId } : { stored: signingSecretId },
      senders: [...new Set(request.permittedSenders)],
      botId: identity.id,
      setup: "pending",
    });
    // Read the safe result before committing so a failed lookup cannot leave
    // the administrator with a created repository but no signing secret.
    const [created] = await tx
      .select(repositorySelection)
      .from(repositories)
      .leftJoin(
        forgeInstances,
        and(
          eq(repositories.forgeId, forgeInstances.id),
          sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .leftJoin(
        agents,
        and(
          eq(repositories.agentId, agents.id),
          sql`${agents.contextId} is not distinct from ${repositories.contextId}`,
        ),
      )
      .where(eq(repositories.id, repository.id));
    return repositoryView(created);
  });
  return { ...result, ...(generatedSecret ? { generatedSecret } : {}) };
}
