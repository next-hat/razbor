import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";

import {
  AuthInputError,
  requireConsoleSession,
  type ConsoleUserView,
} from "@database/src/auth.js";
import type { Database, Transaction } from "@database/src/connection.js";
import {
  addDefaultGuideToRepositories,
  seedDefaultReviewGuide,
} from "@database/src/default-review-guide.js";
import { publicId } from "@database/src/ids.js";
import {
  accountContexts,
  agents,
  consoleUsers,
  forgeInstances,
  githubApps,
  mcpServers,
  organizationInvitations,
  organizationMembers,
  organizationRepositoryGrants,
  repositories,
  skills,
  type OrganizationRole,
} from "@database/src/schema.js";

export type ContextView = {
  id: string;
  name: string;
  kind: "personal" | "organization";
  role: "owner" | OrganizationRole;
  repositoryIds: string[];
};

export type ContextPermission =
  "read" | "repositories" | "skills" | "mcp" | "agents" | "indexer" | "members";

export type OrganizationMemberView = {
  id: string;
  username?: string;
  displayName: string;
  role: OrganizationRole;
  repositoryIds: string[];
};

export type OrganizationInvitationView = {
  id: string;
  contextId: string;
  contextName: string;
  userId: string;
  username?: string;
  displayName: string;
  role: OrganizationRole;
  repositoryIds: string[];
  status: "pending" | "accepted" | "rejected" | "revoked";
  createdAt: string;
};

type UserRow = typeof consoleUsers.$inferSelect;

type ContextRow = typeof accountContexts.$inferSelect;

const organizationRoleSchema = z.enum(["admin", "moderator", "member"]);

const repositoryIdsSchema = z
  .array(publicIdSchema("repository"))
  .max(1000)
  .transform((ids) => [...new Set(ids)]);

const organizationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((name) =>
        [...name].every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      ),
  })
  .strict();

const invitationSchema = z
  .object({
    userId: z.string().trim().min(1).max(64),
    role: organizationRoleSchema,
    repositoryIds: repositoryIdsSchema.default([]),
  })
  .strict();

const memberSchema = z
  .object({
    role: organizationRoleSchema.optional(),
    repositoryIds: repositoryIdsSchema.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0);

/** Reject invalid organization inputs without returning raw submitted data. */
function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AuthInputError(400, "Invalid organization details.");
  return parsed.data;
}

/** Hide SQL and bound credentials while preserving explicit authorization errors. */
function persistenceError(error: unknown): never {
  if (error instanceof AuthInputError) throw error;
  const pg = ((error as { cause?: unknown } | null)?.cause ?? error) as {
    code?: string;
    constraint?: string;
  } | null;
  if (
    pg?.code === "23505" &&
    pg.constraint === "organization_invitations_pending_unique"
  )
    throw new AuthInputError(
      409,
      "This account already has a pending invitation.",
    );
  throw new Error("Unable to access saved organizations.");
}

/** Serialize account and membership authorization with existing account mutations. */
async function lockAccounts(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(748321, 14)`);
}

/** Create one personal context for each account, including provider-created accounts. */
export async function ensurePersonalContext(
  tx: Transaction,
  user: UserRow,
): Promise<ContextRow> {
  const [created] = await tx
    .insert(accountContexts)
    .values({
      publicId: publicId("context"),
      name: (
        user.displayName ??
        user.username ??
        user.email ??
        "Personal account"
      ).slice(0, 100),
      kind: "personal",
      userId: user.id,
    })
    .onConflictDoNothing({ target: accountContexts.userId })
    .returning();
  if (created) {
    await seedDefaultReviewGuide(tx, created.id);
    return created;
  }
  const [context] = await tx
    .select()
    .from(accountContexts)
    .where(eq(accountContexts.userId, user.id));
  return context;
}

/** Resolve the import owner without assigning unowned data to ordinary users. */
export async function defaultImportContextId(
  tx: Transaction,
): Promise<string | null> {
  const [owner] = await tx
    .select()
    .from(consoleUsers)
    .where(eq(consoleUsers.role, "super_admin"))
    .orderBy(asc(consoleUsers.createdAt), asc(consoleUsers.publicId))
    .limit(1);
  return owner ? (await ensurePersonalContext(tx, owner)).id : null;
}

/** Finish legacy ownership after first-account bootstrap; never move an owned resource. */
export async function assignLegacyContexts(tx: Transaction): Promise<void> {
  const contextId = await defaultImportContextId(tx);
  if (!contextId) return;
  const legacyRepositories = await tx
    .select({ id: repositories.id })
    .from(repositories)
    .where(isNull(repositories.contextId));
  for (const table of [
    agents,
    skills,
    mcpServers,
    githubApps,
    forgeInstances,
    repositories,
  ])
    await tx.update(table).set({ contextId }).where(isNull(table.contextId));
  await addDefaultGuideToRepositories(
    tx,
    contextId,
    legacyRepositories.map((repository) => repository.id),
  );
}

/** Convert a public context identifier into an internal UUID without granting access. */
export async function resolveContextId(
  tx: Transaction,
  id: string,
): Promise<string> {
  if (!publicIdSchema("context").safeParse(id).success)
    throw new AuthInputError(404, "Account context not found.");
  const [row] = await tx
    .select({ id: accountContexts.id })
    .from(accountContexts)
    .where(eq(accountContexts.publicId, id));
  if (!row) throw new AuthInputError(404, "Account context not found.");
  return row.id;
}

/** Resolve current membership instead of trusting role data supplied by a browser. */
async function contextRole(
  tx: Transaction,
  context: ContextRow,
  user: UserRow,
): Promise<ContextView["role"] | undefined> {
  if (user.role === "super_admin")
    return context.kind === "personal" && context.userId === user.id
      ? "owner"
      : "admin";
  if (context.kind === "personal")
    return context.userId === user.id ? "owner" : undefined;
  const [membership] = await tx
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.contextId, context.id),
        eq(organizationMembers.userId, user.id),
      ),
    );
  return membership?.role;
}

/** Apply the role matrix shared by repository and configuration mutations. */
function permits(
  role: ContextView["role"],
  permission: ContextPermission,
): boolean {
  return (
    permission === "read" ||
    role === "owner" ||
    role === "admin" ||
    (role === "moderator" &&
      ["repositories", "skills", "mcp"].includes(permission))
  );
}

/** Lock and authorize the owning context against a freshly resolved bearer session. */
export async function requireResourceSession(
  tx: Transaction,
  token: string | undefined,
  contextId: string | null,
  permission: ContextPermission,
): Promise<{
  user: UserRow;
  context: ContextRow | null;
  role: ContextView["role"];
}> {
  await lockAccounts(tx);
  const user = await requireConsoleSession(tx, token);
  if (contextId === null) {
    if (user.role !== "super_admin")
      throw new AuthInputError(403, "Resource access denied.");
    return { user, context: null, role: "owner" };
  }
  const [context] = await tx
    .select()
    .from(accountContexts)
    .where(eq(accountContexts.id, contextId))
    .for("share");
  if (!context) throw new AuthInputError(404, "Account context not found.");
  const role = await contextRole(tx, context, user);
  if (!role || !permits(role, permission))
    throw new AuthInputError(403, "This role cannot manage this resource.");
  return { user, context, role };
}

/** Authorize a selected public context and return its internal ownership identity. */
export async function requireContextSession(
  tx: Transaction,
  token: string | undefined,
  id: string,
  permission: ContextPermission,
): Promise<{ user: UserRow; context: ContextRow; role: ContextView["role"] }> {
  await lockAccounts(tx);
  const contextId = await resolveContextId(tx, id);
  const access = await requireResourceSession(tx, token, contextId, permission);
  return { ...access, context: access.context! };
}

/** Authorize repository reads/review triggers using current ownership and membership grants. */
export async function requireRepositorySession(
  tx: Transaction,
  token: string | undefined,
  repositoryId: string,
  permission: "read" | "repositories" | "indexer",
): Promise<{
  user: UserRow;
  context: ContextRow | null;
  role: ContextView["role"];
}> {
  await lockAccounts(tx);
  const [repository] = await tx
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .for("share");
  if (!repository) throw new AuthInputError(404, "Repository not found.");
  const access = await requireResourceSession(
    tx,
    token,
    repository.contextId,
    permission,
  );
  if (access.role === "member") {
    const [grant] = await tx
      .select({ id: organizationRepositoryGrants.repositoryId })
      .from(organizationRepositoryGrants)
      .where(
        and(
          eq(organizationRepositoryGrants.contextId, repository.contextId!),
          eq(organizationRepositoryGrants.userId, access.user.id),
          eq(organizationRepositoryGrants.repositoryId, repository.id),
        ),
      );
    if (!grant) throw new AuthInputError(403, "Repository access denied.");
  }
  return access;
}

/** List only repositories owned by the selected context that the actor may read. */
async function contextRepositoryIds(
  tx: Transaction,
  context: ContextRow,
  user: UserRow,
  role: ContextView["role"],
): Promise<string[]> {
  const rows = await tx
    .select({ id: repositories.publicId })
    .from(repositories)
    .where(
      and(
        eq(repositories.contextId, context.id),
        role === "member"
          ? inArray(
              repositories.id,
              tx
                .select({ id: organizationRepositoryGrants.repositoryId })
                .from(organizationRepositoryGrants)
                .where(
                  and(
                    eq(organizationRepositoryGrants.contextId, context.id),
                    eq(organizationRepositoryGrants.userId, user.id),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(repositories.publicId));
  return rows.map((row) => row.id);
}

/** Derive global accessible repositories for existing review presentation filters. */
export async function accessibleRepositoryIds(
  tx: Transaction,
  user: UserRow,
): Promise<string[]> {
  const rows = await tx
    .select({ id: repositories.publicId })
    .from(repositories)
    .where(
      user.role === "super_admin"
        ? undefined
        : or(
            inArray(
              repositories.contextId,
              tx
                .select({ id: accountContexts.id })
                .from(accountContexts)
                .where(eq(accountContexts.userId, user.id)),
            ),
            inArray(
              repositories.contextId,
              tx
                .select({ id: organizationMembers.contextId })
                .from(organizationMembers)
                .where(
                  and(
                    eq(organizationMembers.userId, user.id),
                    inArray(organizationMembers.role, ["admin", "moderator"]),
                  ),
                ),
            ),
            inArray(
              repositories.id,
              tx
                .select({ id: organizationRepositoryGrants.repositoryId })
                .from(organizationRepositoryGrants)
                .innerJoin(
                  organizationMembers,
                  and(
                    eq(
                      organizationMembers.contextId,
                      organizationRepositoryGrants.contextId,
                    ),
                    eq(
                      organizationMembers.userId,
                      organizationRepositoryGrants.userId,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(organizationMembers.userId, user.id),
                    eq(organizationMembers.role, "member"),
                    eq(
                      organizationRepositoryGrants.contextId,
                      repositories.contextId,
                    ),
                  ),
                ),
            ),
          ),
    )
    .orderBy(asc(repositories.publicId));
  return rows.map((row) => row.id);
}

/** Re-read enabled account identity for read helpers receiving a public user identifier. */
async function resolveUser(
  tx: Transaction,
  input: ConsoleUserView | string,
): Promise<UserRow> {
  const id = typeof input === "string" ? input : input.id;
  const [user] = await tx
    .select()
    .from(consoleUsers)
    .where(and(eq(consoleUsers.publicId, id), eq(consoleUsers.enabled, true)));
  if (!user) throw new AuthInputError(401, "Sign in to continue.");
  return user;
}

/** Resolve a readable context with its current role and repository access. */
async function contextView(
  tx: Transaction,
  context: ContextRow,
  user: UserRow,
): Promise<ContextView | undefined> {
  const role = await contextRole(tx, context, user);
  if (!role) return undefined;
  return {
    id: context.publicId,
    name: context.name,
    kind: context.kind,
    role,
    repositoryIds: await contextRepositoryIds(tx, context, user, role),
  };
}

/** Enumerate personal and joined organization contexts; super admins can debug all. */
export async function listAccountContexts(
  database: Database,
  input: ConsoleUserView | string,
): Promise<ContextView[]> {
  try {
    return await database.transaction(async (tx) => {
      const user = await resolveUser(tx, input);
      const rows = await tx
        .select()
        .from(accountContexts)
        .where(
          user.role === "super_admin"
            ? undefined
            : or(
                eq(accountContexts.userId, user.id),
                inArray(
                  accountContexts.id,
                  tx
                    .select({ id: organizationMembers.contextId })
                    .from(organizationMembers)
                    .where(eq(organizationMembers.userId, user.id)),
                ),
              ),
        )
        .orderBy(asc(accountContexts.createdAt), asc(accountContexts.publicId));
      const result: ContextView[] = [];
      for (const row of rows) {
        const view = await contextView(tx, row, user);
        if (view) result.push(view);
      }
      return result;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Read a single selected context and reject stale or unauthorized selections. */
export async function getAccountContext(
  database: Database,
  id: string,
  input: ConsoleUserView | string,
): Promise<ContextView> {
  try {
    return await database.transaction(async (tx) => {
      const user = await resolveUser(tx, input);
      const uuid = await resolveContextId(tx, id);
      const [row] = await tx
        .select()
        .from(accountContexts)
        .where(eq(accountContexts.id, uuid));
      const view = await contextView(tx, row, user);
      if (!view)
        throw new AuthInputError(403, "Account context access denied.");
      return view;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Let every enabled account create an organization and become its first admin. */
export async function createOrganization(
  database: Database,
  input: unknown,
  token: string | undefined,
): Promise<ContextView> {
  const request = parseInput(organizationSchema, input);
  try {
    return await database.transaction(async (tx) => {
      await lockAccounts(tx);
      const user = await requireConsoleSession(tx, token);
      const [context] = await tx
        .insert(accountContexts)
        .values({
          publicId: publicId("context"),
          name: request.name,
          kind: "organization",
        })
        .returning();
      await seedDefaultReviewGuide(tx, context.id);
      await tx
        .insert(organizationMembers)
        .values({ contextId: context.id, userId: user.id, role: "admin" });
      return {
        id: context.publicId,
        name: context.name,
        kind: "organization",
        role: "admin",
        repositoryIds: [],
      };
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Ensure membership operations cannot target a personal account context. */
function requireOrganization(context: ContextRow): void {
  if (context.kind !== "organization")
    throw new AuthInputError(400, "Choose an organization.");
}

/** Check direct grants belong to active repositories of the target organization. */
async function validateRepositories(
  tx: Transaction,
  contextId: string,
  ids: string[],
): Promise<string[]> {
  const rows = ids.length
    ? await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.contextId, contextId),
            eq(repositories.status, "active"),
            inArray(repositories.publicId, ids),
          ),
        )
        .for("share")
    : [];
  if (rows.length !== ids.length)
    throw new AuthInputError(
      400,
      "Repository access contains an unavailable organization repository.",
    );
  return rows.map((row) => row.id);
}

/** Replace grants only for an existing member of the repository-owning organization. */
async function setRepositoryGrants(
  tx: Transaction,
  contextId: string,
  userId: string,
  ids: string[],
): Promise<void> {
  const repositoryIds = await validateRepositories(tx, contextId, ids);
  const [membership] = await tx
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.contextId, contextId),
        eq(organizationMembers.userId, userId),
      ),
    );
  if (!membership)
    throw new AuthInputError(404, "Organization member not found.");
  if (membership.role !== "member" && ids.length)
    throw new AuthInputError(
      400,
      "Administrators and moderators already have access to every organization repository.",
    );
  await tx
    .delete(organizationRepositoryGrants)
    .where(
      and(
        eq(organizationRepositoryGrants.contextId, contextId),
        eq(organizationRepositoryGrants.userId, userId),
      ),
    );
  if (repositoryIds.length)
    await tx.insert(organizationRepositoryGrants).values(
      repositoryIds.map((repositoryId) => ({
        contextId,
        userId,
        repositoryId,
      })),
    );
}

/** Return public member profile labels and their explicit repository grants. */
async function memberView(
  tx: Transaction,
  contextId: string,
  user: UserRow,
  role: OrganizationRole,
): Promise<OrganizationMemberView> {
  const rows = await tx
    .select({ id: repositories.publicId })
    .from(organizationRepositoryGrants)
    .innerJoin(
      repositories,
      eq(repositories.id, organizationRepositoryGrants.repositoryId),
    )
    .where(
      and(
        eq(organizationRepositoryGrants.contextId, contextId),
        eq(organizationRepositoryGrants.userId, user.id),
        eq(repositories.contextId, contextId),
      ),
    )
    .orderBy(asc(repositories.publicId));
  return {
    id: user.publicId,
    ...(user.username === null ? {} : { username: user.username }),
    displayName:
      user.displayName ??
      user.username ??
      user.email ??
      "Identity provider account",
    role,
    repositoryIds: rows.map((row) => row.id),
  };
}

/** Let org admins and moderators inspect members when assigning repository access. */
export async function listOrganizationMembers(
  database: Database,
  id: string,
  input: ConsoleUserView | string,
): Promise<OrganizationMemberView[]> {
  try {
    return await database.transaction(async (tx) => {
      const user = await resolveUser(tx, input);
      const uuid = await resolveContextId(tx, id);
      const [context] = await tx
        .select()
        .from(accountContexts)
        .where(eq(accountContexts.id, uuid));
      requireOrganization(context);
      const role = await contextRole(tx, context, user);
      if (!role || !permits(role, "repositories"))
        throw new AuthInputError(
          403,
          "Organization management access required.",
        );
      const rows = await tx
        .select({ user: consoleUsers, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(
          consoleUsers,
          eq(consoleUsers.id, organizationMembers.userId),
        )
        .where(eq(organizationMembers.contextId, uuid))
        .orderBy(asc(consoleUsers.publicId));
      const result: OrganizationMemberView[] = [];
      for (const row of rows)
        result.push(await memberView(tx, uuid, row.user, row.role));
      return result;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Build a secret-free invitation view from the organization and invited account. */
async function invitationView(
  tx: Transaction,
  row: typeof organizationInvitations.$inferSelect,
): Promise<OrganizationInvitationView> {
  const [context] = await tx
    .select()
    .from(accountContexts)
    .where(eq(accountContexts.id, row.contextId));
  const [user] = await tx
    .select()
    .from(consoleUsers)
    .where(eq(consoleUsers.id, row.userId));
  return {
    id: row.publicId,
    contextId: context.publicId,
    contextName: context.name,
    userId: user.publicId,
    ...(user.username === null ? {} : { username: user.username }),
    displayName:
      user.displayName ??
      user.username ??
      user.email ??
      "Identity provider account",
    role: row.role,
    repositoryIds: row.repositoryIds,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Invite an existing enabled account with repositories selected by an org admin. */
export async function inviteOrganizationMember(
  database: Database,
  id: string,
  input: unknown,
  token: string | undefined,
): Promise<OrganizationInvitationView> {
  const request = parseInput(invitationSchema, input);
  try {
    return await database.transaction(async (tx) => {
      const { user: actor, context } = await requireContextSession(
        tx,
        token,
        id,
        "members",
      );
      requireOrganization(context);
      const [user] = await tx
        .select()
        .from(consoleUsers)
        .where(
          and(
            eq(consoleUsers.enabled, true),
            or(
              eq(consoleUsers.publicId, request.userId),
              eq(consoleUsers.username, request.userId.toLowerCase()),
            ),
          ),
        )
        .for("share");
      if (!user)
        throw new AuthInputError(
          404,
          "Enabled account not found. Use its username or account ID.",
        );
      const [existing] = await tx
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.contextId, context.id),
            eq(organizationMembers.userId, user.id),
          ),
        );
      if (existing)
        throw new AuthInputError(
          409,
          "This account is already an organization member.",
        );
      if (request.role !== "member" && request.repositoryIds.length)
        throw new AuthInputError(
          400,
          "Choose repositories only for ordinary members.",
        );
      await validateRepositories(tx, context.id, request.repositoryIds);
      const [row] = await tx
        .insert(organizationInvitations)
        .values({
          publicId: publicId("invitation"),
          contextId: context.id,
          userId: user.id,
          invitedBy: actor.id,
          role: request.role,
          repositoryIds: request.repositoryIds,
        })
        .returning();
      return invitationView(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** List pending invitations addressed to the current enabled account. */
export async function listAccountInvitations(
  database: Database,
  input: ConsoleUserView | string,
): Promise<OrganizationInvitationView[]> {
  try {
    return await database.transaction(async (tx) => {
      const user = await resolveUser(tx, input);
      const rows = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.userId, user.id),
            eq(organizationInvitations.status, "pending"),
          ),
        )
        .orderBy(asc(organizationInvitations.createdAt));
      const result: OrganizationInvitationView[] = [];
      for (const row of rows) result.push(await invitationView(tx, row));
      return result;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Show pending organization invitations exclusively to administrators. */
export async function listOrganizationInvitations(
  database: Database,
  id: string,
  input: ConsoleUserView | string,
): Promise<OrganizationInvitationView[]> {
  try {
    return await database.transaction(async (tx) => {
      const user = await resolveUser(tx, input);
      const uuid = await resolveContextId(tx, id);
      const [context] = await tx
        .select()
        .from(accountContexts)
        .where(eq(accountContexts.id, uuid));
      requireOrganization(context);
      const role = await contextRole(tx, context, user);
      if (!role || !permits(role, "members"))
        throw new AuthInputError(
          403,
          "Organization administrator access required.",
        );
      const rows = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.contextId, uuid),
            eq(organizationInvitations.status, "pending"),
          ),
        )
        .orderBy(asc(organizationInvitations.createdAt));
      const result: OrganizationInvitationView[] = [];
      for (const row of rows) result.push(await invitationView(tx, row));
      return result;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Accept or reject only the actor's pending invitation, revalidating saved grants. */
export async function respondToInvitation(
  database: Database,
  id: string,
  response: "accept" | "reject",
  token: string | undefined,
): Promise<OrganizationInvitationView> {
  if (
    !publicIdSchema("invitation").safeParse(id).success ||
    !["accept", "reject"].includes(response)
  )
    throw new AuthInputError(400, "Invalid invitation response.");
  try {
    return await database.transaction(async (tx) => {
      await lockAccounts(tx);
      const user = await requireConsoleSession(tx, token);
      const [invitation] = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.publicId, id),
            eq(organizationInvitations.userId, user.id),
          ),
        )
        .for("update");
      if (!invitation) throw new AuthInputError(404, "Invitation not found.");
      if (invitation.status !== "pending")
        throw new AuthInputError(
          409,
          "This invitation has already been answered or revoked.",
        );
      if (response === "accept") {
        const [inviter] = await tx
          .select()
          .from(consoleUsers)
          .where(
            and(
              eq(consoleUsers.id, invitation.invitedBy),
              eq(consoleUsers.enabled, true),
            ),
          );
        const [context] = await tx
          .select()
          .from(accountContexts)
          .where(eq(accountContexts.id, invitation.contextId));
        if (!inviter || (await contextRole(tx, context, inviter)) !== "admin")
          throw new AuthInputError(
            409,
            "The inviter no longer has organization administrator access. Ask an administrator for a new invitation.",
          );
        const [existing] = await tx
          .select()
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.contextId, invitation.contextId),
              eq(organizationMembers.userId, user.id),
            ),
          );
        if (existing)
          throw new AuthInputError(
            409,
            "This account is already an organization member.",
          );
        // Removed repositories cannot confer new access through a stale invitation.
        const available = invitation.repositoryIds.length
          ? await tx
              .select({ id: repositories.publicId })
              .from(repositories)
              .where(
                and(
                  eq(repositories.contextId, invitation.contextId),
                  eq(repositories.status, "active"),
                  inArray(repositories.publicId, invitation.repositoryIds),
                ),
              )
          : [];
        await tx.insert(organizationMembers).values({
          contextId: invitation.contextId,
          userId: user.id,
          role: invitation.role,
        });
        await setRepositoryGrants(
          tx,
          invitation.contextId,
          user.id,
          available.map((row) => row.id),
        );
      }
      const [row] = await tx
        .update(organizationInvitations)
        .set({
          status: response === "accept" ? "accepted" : "rejected",
          updatedAt: new Date(),
        })
        .where(eq(organizationInvitations.id, invitation.id))
        .returning();
      return invitationView(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Revoke a pending invitation while keeping its durable response history. */
export async function revokeOrganizationInvitation(
  database: Database,
  contextId: string,
  id: string,
  token: string | undefined,
): Promise<void> {
  if (!publicIdSchema("invitation").safeParse(id).success)
    throw new AuthInputError(404, "Invitation not found.");
  try {
    await database.transaction(async (tx) => {
      const { context } = await requireContextSession(
        tx,
        token,
        contextId,
        "members",
      );
      requireOrganization(context);
      const [row] = await tx
        .update(organizationInvitations)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.publicId, id),
            eq(organizationInvitations.contextId, context.id),
            eq(organizationInvitations.status, "pending"),
          ),
        )
        .returning({ id: organizationInvitations.id });
      if (!row) throw new AuthInputError(404, "Pending invitation not found.");
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Preserve at least one enabled organization administrator during role/removal edits. */
async function preserveAdministrator(
  tx: Transaction,
  contextId: string,
  userId: string,
  currentRole: OrganizationRole,
  nextRole?: OrganizationRole,
): Promise<void> {
  if (currentRole !== "admin" || nextRole === "admin") return;
  const admins = await tx
    .select({ id: consoleUsers.id })
    .from(organizationMembers)
    .innerJoin(consoleUsers, eq(consoleUsers.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.contextId, contextId),
        eq(organizationMembers.role, "admin"),
        eq(consoleUsers.enabled, true),
      ),
    );
  if (!admins.some((admin) => admin.id !== userId))
    throw new AuthInputError(
      409,
      "At least one enabled organization administrator is required.",
    );
}

/** Change organization roles as admin, or explicit repository access as admin/moderator. */
export async function updateOrganizationMember(
  database: Database,
  contextId: string,
  id: string,
  input: unknown,
  token: string | undefined,
): Promise<OrganizationMemberView> {
  const request = parseInput(memberSchema, input);
  if (!publicIdSchema("user").safeParse(id).success)
    throw new AuthInputError(404, "Organization member not found.");
  try {
    return await database.transaction(async (tx) => {
      const { context } = await requireContextSession(
        tx,
        token,
        contextId,
        request.role === undefined ? "repositories" : "members",
      );
      requireOrganization(context);
      const [row] = await tx
        .select({ user: consoleUsers, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(
          consoleUsers,
          eq(consoleUsers.id, organizationMembers.userId),
        )
        .where(
          and(
            eq(organizationMembers.contextId, context.id),
            eq(consoleUsers.publicId, id),
          ),
        );
      if (!row) throw new AuthInputError(404, "Organization member not found.");
      if (
        request.repositoryIds !== undefined &&
        (request.role ?? row.role) !== "member"
      )
        throw new AuthInputError(
          400,
          "Repository access can be assigned only to ordinary members.",
        );
      if (request.role !== undefined) {
        await preserveAdministrator(
          tx,
          context.id,
          row.user.id,
          row.role,
          request.role,
        );
        await tx
          .update(organizationMembers)
          .set({ role: request.role, updatedAt: new Date() })
          .where(
            and(
              eq(organizationMembers.contextId, context.id),
              eq(organizationMembers.userId, row.user.id),
            ),
          );
      }
      if (request.repositoryIds !== undefined)
        await setRepositoryGrants(
          tx,
          context.id,
          row.user.id,
          request.repositoryIds,
        );
      else if (request.role !== undefined && request.role !== row.role)
        // A role transition never revives dormant access from an earlier membership role.
        await setRepositoryGrants(tx, context.id, row.user.id, []);
      return memberView(tx, context.id, row.user, request.role ?? row.role);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Remove a membership and its cascading repository grants under live admin authority. */
export async function removeOrganizationMember(
  database: Database,
  contextId: string,
  id: string,
  token: string | undefined,
): Promise<void> {
  if (!publicIdSchema("user").safeParse(id).success)
    throw new AuthInputError(404, "Organization member not found.");
  try {
    await database.transaction(async (tx) => {
      const { context } = await requireContextSession(
        tx,
        token,
        contextId,
        "members",
      );
      requireOrganization(context);
      const [row] = await tx
        .select({ userId: consoleUsers.id, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(
          consoleUsers,
          eq(consoleUsers.id, organizationMembers.userId),
        )
        .where(
          and(
            eq(organizationMembers.contextId, context.id),
            eq(consoleUsers.publicId, id),
          ),
        );
      if (!row) throw new AuthInputError(404, "Organization member not found.");
      await preserveAdministrator(tx, context.id, row.userId, row.role);
      await tx
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.contextId, context.id),
            eq(organizationMembers.userId, row.userId),
          ),
        );
    });
  } catch (error) {
    return persistenceError(error);
  }
}
