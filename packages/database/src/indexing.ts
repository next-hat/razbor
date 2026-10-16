import { isDeepStrictEqual } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { publicIdSchema } from "@razbor/contracts";

import { requireContextSession } from "@database/src/contexts.js";
import type { Database } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import {
  repositories,
  indexWorkspaces,
  indexAccessTokens,
  indexAccessTokenWorkspaces,
  legacyRevocations,
  reviews,
  reviewAttempts,
  runners,
  type GitPolicy,
} from "@database/src/schema.js";

/**
 * Hash an index bearer token for storage and authorization lookup without
 * retaining its plaintext.
 */
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const additionalTokenWorkspace = sql`exists (
  select 1 from ${indexAccessTokenWorkspaces}
  where ${indexAccessTokenWorkspaces.tokenId} = ${indexAccessTokens.id}
    and ${indexAccessTokenWorkspaces.workspaceId} = ${indexWorkspaces.id}
)`;

// Tokens can outlive a short renewable lease, but never authorize an expired,
// replaced, completed, or revoked attempt/session.
const liveReviewWorkspace = sql`(not ${indexWorkspaces.temporary} or exists (
  select 1 from review_attempts a join reviews v on v.id = a.review_id
  left join runners r on r.id = a.runner_id
  where a.id = ${indexWorkspaces.attemptId} and a.status = 'running'
    and v.status = 'running' and v.version = a.version and a.lease_until > now()
    and (a.runner_id is null or (a.deadline > now() and r.session_id = a.runner_session_id
      and r.state <> 'revoked' and r.credential_hash is not null and r.session_expires_at > now()))
))`;

const tokenWorkspaceBinding = and(
  sql`exists (
    select 1 from repositories candidate_repository
    join index_workspaces token_primary_workspace on token_primary_workspace.id = ${indexAccessTokens.workspaceId}
    join repositories token_primary_repository on token_primary_repository.id = token_primary_workspace.repository_id
    where candidate_repository.id = ${indexWorkspaces.repositoryId}
      and candidate_repository.context_id is not distinct from token_primary_repository.context_id
  )`,
  or(
    and(
      eq(indexAccessTokens.allRepositories, false),
      or(
        eq(indexAccessTokens.workspaceId, indexWorkspaces.id),
        additionalTokenWorkspace,
      ),
    ),
    and(
      eq(indexAccessTokens.allRepositories, true),
      eq(indexWorkspaces.temporary, false),
      isNull(indexWorkspaces.expiresAt),
      sql`${indexWorkspaces.state} in ('ready','unready')`,
      sql`${indexWorkspaces.owner} = (
      select owner from index_workspaces where id = ${indexAccessTokens.workspaceId}
    )`,
      sql`exists (
      select 1 from repositories bound_repository
      where bound_repository.id = ${indexWorkspaces.repositoryId}
        and bound_repository.index_owner = ${indexWorkspaces.owner}
        and bound_repository.status = 'active'
    )`,
    ),
  ),
);

/**
 * Create missing persistent workspace records for an indexer owner; reject
 * existing ownership or Git policy changes that require explicit migration.
 */
export async function ensureDevelopmentWorkspaces(
  database: Database,
  owner: string,
  dataRoot: string,
  repositoryId?: string,
) {
  if (repositoryId) publicIdSchema("repository").parse(repositoryId);
  await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(748321, 3)`);
    const repos = await tx
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.indexOwner, owner),
          eq(repositories.status, "active"),
          repositoryId
            ? eq(repositories.publicId, repositoryId)
            : eq(repositories.persistent, true),
        ),
      )
      .for("share");
    if (repositoryId && !repos.length)
      throw new Error("repository owner mismatch");
    for (const repo of repos) {
      const [existing] = await tx
        .select()
        .from(indexWorkspaces)
        .where(
          and(
            eq(indexWorkspaces.repositoryId, repo.id),
            eq(indexWorkspaces.temporary, false),
          ),
        );
      if (existing) {
        if (existing.owner !== owner)
          throw new Error("workspace owner conflict");
        // Existing checkout remains bound to its declared Git policy. A policy change
        // needs explicit operator migration, never an unnoticed remote replacement.
        if (!isDeepStrictEqual(existing.git, repo.git))
          throw new Error(
            "persistent workspace policy changed; operator migration required",
          );
      } else {
        const id = publicId("workspace");
        await tx.insert(indexWorkspaces).values({
          publicId: id,
          repositoryId: repo.id,
          owner,
          root: path.join(dataRoot, "development", id),
          temporary: false,
          git: repo.git,
        });
      }
    }
  });
}

/**
 * Read an indexer's undeleted workspace mappings for internal filesystem
 * management, translating database IDs to public IDs.
 */
export async function ownedWorkspaces(database: Database, owner: string) {
  const rows = await database.db
    .select({
      workspace: indexWorkspaces,
      repositoryPublicId: repositories.publicId,
      repositoryStatus: repositories.status,
      attemptPublicId: reviewAttempts.publicId,
    })
    .from(indexWorkspaces)
    .innerJoin(repositories, eq(indexWorkspaces.repositoryId, repositories.id))
    .leftJoin(reviewAttempts, eq(indexWorkspaces.attemptId, reviewAttempts.id))
    .where(
      and(
        eq(indexWorkspaces.owner, owner),
        sql`${indexWorkspaces.state} <> 'deleted'`,
      ),
    );
  // Server-private filesystem/policy mapping; UUIDs stop at this package boundary.
  return rows.map(
    ({
      workspace: w,
      repositoryPublicId,
      repositoryStatus,
      attemptPublicId,
    }) => ({
      id: w.publicId,
      repositoryId: repositoryPublicId,
      repositoryStatus,
      attemptId: attemptPublicId,
      root: w.root,
      temporary: w.temporary,
      git: w.git,
      state: w.state,
      headSha: w.headSha,
      baseSha: w.baseSha,
      expiresAt: w.expiresAt?.getTime(),
    }),
  );
}

/**
 * Create a temporary source workspace only for the current live attempt and
 * exact commit pair, bounded by its fixed deadline or legacy lease.
 */
export async function createReviewWorkspace(
  database: Database,
  owner: string,
  dataRoot: string,
  lease: {
    attemptId: string;
    reviewId: string;
    repositoryId: string;
    baseSha: string;
    headSha: string;
    ttlMs: number;
  },
) {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        review: reviews,
        attempt: reviewAttempts,
        repository: repositories,
      })
      .from(reviewAttempts)
      .innerJoin(reviews, eq(reviewAttempts.reviewId, reviews.id))
      .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
      .where(
        and(
          eq(reviewAttempts.publicId, lease.attemptId),
          eq(reviews.publicId, lease.reviewId),
          eq(repositories.publicId, lease.repositoryId),
        ),
      )
      .for("update", { of: reviews });
    if (
      row?.repository.status !== "active" ||
      row.review.source.indexOwner !== owner ||
      row.review.status !== "running" ||
      row.attempt.status !== "running" ||
      row.review.version !== row.attempt.version ||
      row.attempt.leaseUntil <= new Date() ||
      row.review.headSha !== lease.headSha ||
      row.review.baseSha !== lease.baseSha
    )
      throw new Error("invalid review workspace binding");
    if (row.attempt.runnerId) {
      const [runner] = await tx
        .select()
        .from(runners)
        .where(eq(runners.id, row.attempt.runnerId))
        .for("share");
      if (
        !runner ||
        runner.state === "revoked" ||
        !runner.credentialHash ||
        runner.sessionId !== row.attempt.runnerSessionId ||
        !runner.sessionExpiresAt ||
        runner.sessionExpiresAt <= new Date() ||
        !row.attempt.deadline ||
        row.attempt.deadline <= new Date()
      )
        throw new Error("invalid review runner session binding");
    }
    const id = publicId("workspace");
    const root = path.join(dataRoot, "reviews", id);
    await tx.insert(indexWorkspaces).values({
      publicId: id,
      root,
      owner,
      repositoryId: row.repository.id,
      attemptId: row.attempt.id,
      temporary: true,
      git: row.review.source.git,
      baseSha: lease.baseSha,
      headSha: lease.headSha,
      // Registered attempts use a fixed execution deadline; every access still
      // validates their short renewable lease and current runner session.
      expiresAt: row.attempt.deadline ?? row.attempt.leaseUntil,
    });
    return { id, root, git: row.review.source.git };
  });
}

/**
 * Publish an owned workspace's readiness or acknowledge deletion, rejecting
 * incompatible lifecycle transitions and inactive repositories.
 */
export async function workspaceState(
  database: Database,
  owner: string,
  id: string,
  state: "unready" | "ready" | "deleted",
  headSha?: string,
  indexedAt?: Date,
  indexSha = headSha,
) {
  publicIdSchema("workspace").parse(id);
  const result = await database.db
    .update(indexWorkspaces)
    .set({
      state,
      updatedAt: state === "ready" && indexedAt ? indexedAt : new Date(),
      ...(state === "ready" ? { headSha, indexSha } : { indexSha: null }),
    })
    .where(
      and(
        eq(indexWorkspaces.publicId, id),
        eq(indexWorkspaces.owner, owner),
        state === "deleted"
          ? eq(indexWorkspaces.state, "deleting")
          : and(
              sql`${indexWorkspaces.state} in ('ready','unready')`,
              sql`exists (select 1 from ${repositories}
                where ${repositories.id} = ${indexWorkspaces.repositoryId}
                  and ${repositories.status} = 'active')`,
            ),
      ),
    )
    .returning({ publicId: indexWorkspaces.publicId });
  if (!result.length) throw new Error("workspace lifecycle conflict");
}

/**
 * Revoke temporary workspace tokens and mark cleanup pending; persistent
 * workspaces can be removed only as part of repository deletion.
 */
export async function startWorkspaceDeletion(
  database: Database,
  owner: string,
  id: string,
) {
  publicIdSchema("workspace").parse(id);
  await database.transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(indexWorkspaces)
      .where(
        and(eq(indexWorkspaces.publicId, id), eq(indexWorkspaces.owner, owner)),
      )
      .for("update");
    if (!w) throw new Error("owned workspace required");
    if (!w.temporary) {
      const [repository] = await tx
        .select({ status: repositories.status })
        .from(repositories)
        .where(eq(repositories.id, w.repositoryId));
      if (repository?.status !== "deleting")
        throw new Error("persistent workspace requires repository deletion");
    }
    if (w.temporary)
      await tx
        .update(indexAccessTokens)
        .set({
          revokedAt: sql`coalesce(${indexAccessTokens.revokedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(eq(indexAccessTokens.workspaceId, w.id));
    if (w.state !== "deleted")
      await tx
        .update(indexWorkspaces)
        .set({ state: "deleting", indexSha: null, updatedAt: new Date() })
        .where(eq(indexWorkspaces.id, w.id));
  });
}

/**
 * Issue a workspace-bound bearer token with expiry capped by workspace
 * lifetime; temporary attempts cannot receive refresh permission.
 */
export async function issueToken(
  database: Database,
  workspaceId: string,
  owner: string,
  options: { refresh: boolean; ttlMs?: number },
) {
  publicIdSchema("workspace").parse(workspaceId);
  const token = randomBytes(32).toString("base64url");
  const record = await database.transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(indexWorkspaces)
      .where(
        and(
          eq(indexWorkspaces.publicId, workspaceId),
          eq(indexWorkspaces.owner, owner),
          liveReviewWorkspace,
          sql`exists (select 1 from ${repositories}
            where ${repositories.id} = ${indexWorkspaces.repositoryId}
              and ${repositories.status} = 'active')`,
        ),
      )
      .for("update");
    if (
      !w ||
      ["deleted", "deleting"].includes(w.state) ||
      (w.temporary && options.refresh)
    )
      throw new Error("workspace unavailable");
    const expiresAt = options.ttlMs
      ? new Date(Date.now() + options.ttlMs)
      : null;
    const boundedExpiry =
      w.expiresAt && (!expiresAt || w.expiresAt < expiresAt)
        ? w.expiresAt
        : expiresAt;
    if (boundedExpiry && boundedExpiry <= new Date())
      throw new Error("workspace expired");
    const [t] = await tx
      .insert(indexAccessTokens)
      .values({
        publicId: publicId("token"),
        workspaceId: w.id,
        hash: tokenHash(token),
        refresh: options.refresh,
        expiresAt: boundedExpiry,
      })
      .returning();
    if (w.temporary)
      await tx
        .update(indexWorkspaces)
        .set({ expiresAt: boundedExpiry, updatedAt: new Date() })
        .where(eq(indexWorkspaces.id, w.id));
    return { id: t.publicId, workspaceId, expiresAt: t.expiresAt?.getTime() };
  });
  return { ...record, token };
}

/**
 * Resolve a token's current grants, rejecting expiry, revocation and stale
 * attempt authority; repository-wide grants remain within the primary
 * workspace's indexer owner and account context.
 */
export async function authorizeHash(
  database: Database,
  hash: string,
  owner: string,
) {
  const rows = await database.db
    .select({
      id: indexAccessTokens.publicId,
      workspace: indexWorkspaces.publicId,
      repository: repositories.publicId,
      configKey: repositories.configKey,
      selector: repositories.selector,
      observed: repositories.observed,
      refresh: indexAccessTokens.refresh,
      allRepositories: indexAccessTokens.allRepositories,
      multipleProjects: sql<boolean>`${indexAccessTokens.allRepositories} or exists (
        select 1 from ${indexAccessTokenWorkspaces}
        where ${indexAccessTokenWorkspaces.tokenId} = ${indexAccessTokens.id}
      )`,
      expiresAt: indexAccessTokens.expiresAt,
    })
    .from(indexAccessTokens)
    .innerJoin(indexWorkspaces, tokenWorkspaceBinding)
    .innerJoin(repositories, eq(indexWorkspaces.repositoryId, repositories.id))
    .where(
      and(
        eq(indexAccessTokens.hash, hash),
        eq(indexWorkspaces.owner, owner),
        liveReviewWorkspace,
        eq(repositories.status, "active"),
        isNull(indexAccessTokens.revokedAt),
        or(
          isNull(indexAccessTokens.expiresAt),
          sql`${indexAccessTokens.expiresAt} > now()`,
        ),
        sql`${indexWorkspaces.state} in ('ready','unready')`,
        or(
          isNull(indexWorkspaces.expiresAt),
          sql`${indexWorkspaces.expiresAt} > now()`,
        ),
        sql`not exists (select 1 from ${legacyRevocations} where ${legacyRevocations.hash} = ${hash})`,
      ),
    )
    .orderBy(
      sql`case when ${indexAccessTokens.workspaceId} = ${indexWorkspaces.id} then 0 else 1 end`,
      indexWorkspaces.publicId,
    );
  const [row] = rows;
  if (!row) throw new Error("invalid, expired or revoked token");
  return {
    id: row.id,
    workspace: row.workspace,
    repository: row.repository,
    scopes: rows.map(
      ({ workspace, repository, configKey, selector, observed }) => ({
        workspace,
        repository,
        name: observed?.fullPath ?? selector ?? configKey,
      }),
    ),
    refresh: row.refresh,
    allRepositories: row.allRepositories,
    multipleProjects: row.multipleProjects,
    expiresAt: row.expiresAt?.getTime(),
  };
}

/**
 * Revoke a token idempotently, optionally requiring an indexer-owned workspace
 * binding; fail if no matching token exists.
 */
export async function revokeToken(
  database: Database,
  id: string,
  owner?: string,
  contextId?: string,
  sessionToken?: string,
) {
  publicIdSchema("token").parse(id);
  const condition = owner
    ? sql`exists (
        select 1 from ${indexWorkspaces}
        where ${indexWorkspaces.owner} = ${owner}
          and (${indexAccessTokens.workspaceId} = ${indexWorkspaces.id} or ${additionalTokenWorkspace})
      )`
    : sql`true`;
  await database.transaction(async (tx) => {
    if (sessionToken !== undefined)
      await requireContextSession(tx, sessionToken, contextId ?? "", "indexer");
    const rows = await tx
      .update(indexAccessTokens)
      .set({
        revokedAt: sql`coalesce(${indexAccessTokens.revokedAt},now())`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(indexAccessTokens.publicId, id),
          condition,
          contextId === undefined
            ? undefined
            : sql`exists (select 1 from index_workspaces primary_workspace join repositories primary_repository on primary_repository.id = primary_workspace.repository_id where primary_workspace.id = ${indexAccessTokens.workspaceId} and primary_repository.context_id = (select id from account_contexts where public_id = ${contextId}))`,
        ),
      )
      .returning({ publicId: indexAccessTokens.publicId });
    if (!rows.length) throw new Error("token unavailable");
  });
}

/**
 * List up to one hundred token metadata records without hashes, retaining
 * every scope even when filtering by one repository.
 */
export async function listTokens(
  database: Database,
  owner?: string,
  repositoryId?: string,
  contextId?: string,
) {
  if (repositoryId) publicIdSchema("repository").parse(repositoryId);
  // Limit keys before expanding their bindings so a large key never loses scopes
  // and repository filtering still returns the key's complete grant list.
  const selectedTokens = database.db
    .selectDistinct({
      id: indexAccessTokens.id,
      createdAt: indexAccessTokens.createdAt,
    })
    .from(indexAccessTokens)
    .innerJoin(
      indexWorkspaces,
      or(
        eq(indexAccessTokens.workspaceId, indexWorkspaces.id),
        tokenWorkspaceBinding,
      ),
    )
    .innerJoin(repositories, eq(indexWorkspaces.repositoryId, repositories.id))
    .where(
      and(
        owner ? eq(indexWorkspaces.owner, owner) : undefined,
        contextId === undefined
          ? undefined
          : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        repositoryId
          ? or(
              and(
                eq(indexAccessTokens.allRepositories, false),
                eq(repositories.publicId, repositoryId),
              ),
              and(
                eq(indexAccessTokens.allRepositories, true),
                sql`exists (
              select 1 from repositories selected_repository
              join index_workspaces primary_workspace
                on primary_workspace.id = ${indexAccessTokens.workspaceId}
              where selected_repository.public_id = ${repositoryId}
                and selected_repository.index_owner = primary_workspace.owner
                and selected_repository.context_id is not distinct from (select context_id from repositories where id = primary_workspace.repository_id)
            )`,
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(indexAccessTokens.createdAt), indexAccessTokens.id)
    .limit(100)
    .as("selected_tokens");
  const primaryWorkspace = alias(indexWorkspaces, "primary_workspace");
  const primaryRepository = alias(repositories, "primary_repository");
  const rows = await database.db
    .select({
      id: indexAccessTokens.publicId,
      workspaceId: primaryWorkspace.publicId,
      repositoryId: primaryRepository.publicId,
      refresh: indexAccessTokens.refresh,
      allRepositories: indexAccessTokens.allRepositories,
      expiresAt: indexAccessTokens.expiresAt,
      revokedAt: indexAccessTokens.revokedAt,
      scopeWorkspaceId: indexWorkspaces.publicId,
      scopeRepositoryId: repositories.publicId,
      configKey: repositories.configKey,
      selector: repositories.selector,
      observed: repositories.observed,
    })
    .from(indexAccessTokens)
    .innerJoin(selectedTokens, eq(indexAccessTokens.id, selectedTokens.id))
    .innerJoin(
      primaryWorkspace,
      eq(indexAccessTokens.workspaceId, primaryWorkspace.id),
    )
    .innerJoin(
      primaryRepository,
      eq(primaryWorkspace.repositoryId, primaryRepository.id),
    )
    .leftJoin(indexWorkspaces, tokenWorkspaceBinding)
    .leftJoin(repositories, eq(indexWorkspaces.repositoryId, repositories.id))
    .orderBy(
      desc(indexAccessTokens.createdAt),
      indexAccessTokens.id,
      sql`case when ${indexAccessTokens.workspaceId} = ${indexWorkspaces.id} then 0 else 1 end`,
      repositories.configKey,
    );
  const tokens = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      repositoryId: string;
      refresh: boolean;
      allRepositories: boolean;
      expiresAt: string | null;
      revokedAt: string | null;
      scopes: { workspaceId: string; repositoryId: string; name: string }[];
    }
  >();
  for (const row of rows) {
    const token = tokens.get(row.id) ?? {
      id: row.id,
      workspaceId: row.workspaceId,
      repositoryId: row.repositoryId,
      refresh: row.refresh,
      allRepositories: row.allRepositories,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      scopes: [],
    };
    if (row.scopeWorkspaceId && row.scopeRepositoryId && row.configKey)
      token.scopes.push({
        workspaceId: row.scopeWorkspaceId,
        repositoryId: row.scopeRepositoryId,
        name: row.observed?.fullPath ?? row.selector ?? row.configKey,
      });
    tokens.set(row.id, token);
  }
  return [...tokens.values()];
}

export type WorkspacePolicy = GitPolicy;

// Management DTO: expose registered projects and current workspaces, never paths,
// Git credentials, token hashes or database UUIDs.
/**
 * Expose registered project and persistent index readiness for management,
 * excluding filesystem paths, credentials and internal database IDs.
 */
export async function listIndexProjects(
  database: Database,
  repositoryId?: string,
  contextId?: string,
) {
  if (repositoryId) publicIdSchema("repository").parse(repositoryId);
  const rows = await database.db
    .select({
      repositoryId: repositories.publicId,
      repositoryStatus: repositories.status,
      configKey: repositories.configKey,
      selector: repositories.selector,
      observed: repositories.observed,
      persistent: repositories.persistent,
      workspaceId: indexWorkspaces.publicId,
      temporary: indexWorkspaces.temporary,
      state: indexWorkspaces.state,
      indexSha: indexWorkspaces.indexSha,
      updatedAt: indexWorkspaces.updatedAt,
      expiresAt: indexWorkspaces.expiresAt,
    })
    .from(repositories)
    .leftJoin(
      indexWorkspaces,
      and(
        eq(indexWorkspaces.repositoryId, repositories.id),
        eq(indexWorkspaces.temporary, false),
        sql`${indexWorkspaces.state} <> 'deleted'`,
      ),
    )
    .where(
      and(
        repositoryId ? eq(repositories.publicId, repositoryId) : undefined,
        contextId === undefined
          ? undefined
          : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      ),
    )
    .orderBy(repositories.configKey, indexWorkspaces.createdAt);
  return rows.map((row) => {
    const defaultState = row.persistent ? "not-provisioned" : "on-demand";
    let state = row.state ?? defaultState;
    if (row.repositoryStatus === "deleting") state = "deleting";
    else if (row.expiresAt && row.expiresAt <= new Date()) state = "expired";
    return {
      id: row.workspaceId,
      repositoryId: row.repositoryId,
      name: row.observed?.fullPath ?? row.selector ?? row.configKey,
      configKey: row.configKey,
      kind: row.temporary ? ("review" as const) : ("persistent" as const),
      state,
      headSha: row.state === "ready" ? row.indexSha : null,
      // Persistent ready rows carry the MCP index's publication timestamp.
      // Temporary rows also change on token issuance, so their generic
      // update timestamp is NOT an indexing date. No new tracking is introduced.
      indexedAt:
        !row.temporary && row.state === "ready" && row.indexSha
          ? row.updatedAt!.toISOString()
          : null,
      canCreateToken:
        row.repositoryStatus === "active" &&
        !!row.workspaceId &&
        !row.temporary &&
        !row.expiresAt &&
        (row.state === "ready" || row.state === "unready"),
    };
  });
}

/**
 * Issue a management key for active persistent workspaces belonging to one
 * indexer and account, optionally granting all repositories in that account.
 */
export async function createIndexToken(
  database: Database,
  workspaceId: string | string[],
  refresh: boolean,
  allRepositories = false,
  contextId?: string,
  sessionToken?: string,
) {
  const workspaceIds = [
    ...new Set(typeof workspaceId === "string" ? [workspaceId] : workspaceId),
  ];
  if (!workspaceIds.length) throw new Error("persistent index required");
  for (const id of workspaceIds) publicIdSchema("workspace").parse(id);
  const token = randomBytes(32).toString("base64url");
  const record = await database.transaction(async (tx) => {
    if (sessionToken !== undefined)
      await requireContextSession(tx, sessionToken, contextId ?? "", "indexer");
    const workspaces = await tx
      .select({
        ...getTableColumns(indexWorkspaces),
        contextId: repositories.contextId,
      })
      .from(indexWorkspaces)
      .innerJoin(
        repositories,
        eq(indexWorkspaces.repositoryId, repositories.id),
      )
      .where(
        and(
          inArray(indexWorkspaces.publicId, workspaceIds),
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          sql`exists (select 1 from ${repositories}
            where ${repositories.id} = ${indexWorkspaces.repositoryId}
              and ${repositories.status} = 'active')`,
          eq(indexWorkspaces.temporary, false),
          isNull(indexWorkspaces.expiresAt),
          sql`${indexWorkspaces.state} in ('ready','unready')`,
        ),
      )
      .orderBy(indexWorkspaces.id)
      .for("update", { of: indexWorkspaces });
    if (workspaces.length !== workspaceIds.length)
      throw new Error("persistent index required");
    if (new Set(workspaces.map((workspace) => workspace.contextId)).size !== 1)
      throw new Error("workspace account mismatch");
    if (new Set(workspaces.map((workspace) => workspace.owner)).size !== 1)
      throw new Error("workspace owner mismatch");
    const primary = workspaces.find(
      (workspace) => workspace.publicId === workspaceIds[0],
    )!;
    const [created] = await tx
      .insert(indexAccessTokens)
      .values({
        publicId: publicId("token"),
        workspaceId: primary.id,
        hash: tokenHash(token),
        refresh,
        allRepositories,
      })
      .returning();
    const additional = workspaces.filter(
      (workspace) => workspace.id !== primary.id,
    );
    if (!allRepositories && additional.length)
      await tx.insert(indexAccessTokenWorkspaces).values(
        additional.map((workspace) => ({
          tokenId: created.id,
          workspaceId: workspace.id,
        })),
      );
    return {
      id: created.publicId,
      workspaceId: primary.publicId,
      workspaceIds,
      allRepositories,
      expiresAt: created.expiresAt?.getTime(),
    };
  });
  return { ...record, token };
}

/** Require an active repository assigned to the supplied indexer owner. */
export async function assertRepositoryActive(
  database: Database,
  owner: string,
  repositoryId: string,
) {
  publicIdSchema("repository").parse(repositoryId);
  const [repository] = await database.db
    .select({ id: repositories.publicId })
    .from(repositories)
    .where(
      and(
        eq(repositories.publicId, repositoryId),
        eq(repositories.indexOwner, owner),
        eq(repositories.status, "active"),
      ),
    );
  if (!repository) throw new Error("repository unavailable");
}

/**
 * Return interrupted indexing setup to pending for this owner's active
 * repositories after restart.
 */
export async function recoverRepositoryIndexSetup(
  database: Database,
  owner: string,
) {
  await database.db
    .update(repositories)
    .set({ setupState: "pending", setupError: null, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.indexOwner, owner),
        eq(repositories.status, "active"),
        eq(repositories.setupState, "indexing"),
      ),
    );
}

/** Read the oldest batch of active repositories awaiting setup by this indexer. */
export async function pendingRepositoryIndexes(
  database: Database,
  owner: string,
) {
  return database.db
    .select({ id: repositories.publicId })
    .from(repositories)
    .where(
      and(
        eq(repositories.indexOwner, owner),
        eq(repositories.status, "active"),
        eq(repositories.setupState, "pending"),
      ),
    )
    .orderBy(repositories.createdAt)
    .limit(16);
}

/**
 * Update owned repository setup state only while lifecycle and optional Git
 * policy still match; return whether the guarded update succeeded.
 */
export async function repositoryIndexSetup(
  database: Database,
  owner: string,
  repositoryId: string,
  state: "pending" | "indexing" | "ready" | "error",
  error?: string,
  policy?: GitPolicy,
) {
  publicIdSchema("repository").parse(repositoryId);
  const updated = await database.db
    .update(repositories)
    .set({
      setupState: state,
      setupError:
        state === "error"
          ? (error?.slice(0, 256) ?? "Indexing failed; retry setup.")
          : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositories.publicId, repositoryId),
        eq(repositories.indexOwner, owner),
        eq(repositories.status, "active"),
        state === "ready" || state === "error"
          ? eq(repositories.setupState, "indexing")
          : undefined,
        policy
          ? sql`${repositories.git} = ${JSON.stringify(policy)}::jsonb`
          : undefined,
      ),
    )
    .returning({ id: repositories.publicId });
  return updated.length > 0;
}
