import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";

import type { Database, Transaction } from "@database/src/connection.js";
import {
  accessibleRepositoryIds,
  ensurePersonalContext,
  assignLegacyContexts,
} from "@database/src/contexts.js";
import { publicId } from "@database/src/ids.js";
import { consoleSessions, consoleUsers } from "@database/src/schema.js";

export type ConsoleUserView = {
  id: string;
  username?: string;
  displayName: string;
  email?: string;
  role: "super_admin" | "user";
  enabled: boolean;
  authenticationMethod: "local" | "oidc";
  oidcIssuer?: string;
  mustChangePassword: boolean;
  repositoryIds: string[];
};

export type ConsoleSession = {
  user: ConsoleUserView;
  token: string;
  expiresAt: Date;
};

export class AuthInputError extends Error {
  /** Carry an API-safe account validation, authentication, or conflict error. */
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);

const passwordSchema = z
  .string()
  .min(12)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1024);

const roleSchema = z
  .enum(["admin", "super_admin", "user"])
  .transform((role) => (role === "admin" ? ("super_admin" as const) : role));

const createUserSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    role: roleSchema,
  })
  .strict();

const updateUserSchema = z
  .object({
    password: passwordSchema.optional(),
    role: roleSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export type CreateConsoleUserInput = z.input<typeof createUserSchema>;

export type UpdateConsoleUserInput = z.input<typeof updateUserSchema>;

const oidcUserSchema = z
  .object({
    issuer: z
      .string()
      .url()
      .refine((value) => Buffer.byteLength(value, "utf8") <= 2048),
    subject: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 255),
    role: roleSchema,
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(isSafeProfileText)
      .optional(),
    email: z
      .string()
      .trim()
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+$/)
      .refine(isSafeProfileText)
      .optional(),
  })
  .strict();

export type AuthenticateOidcUserInput = z.input<typeof oidcUserSchema>;

const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const dummyPasswordHash = `scrypt$${"00".repeat(16)}$${"00".repeat(32)}`;

/** Reject embedded control characters in provider profile labels and email. */
function isSafeProfileText(value: string): boolean {
  return [...value].every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
}

/** Validate account input without putting submitted passwords into errors. */
function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  fieldName?: "username" | "password",
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const field = fieldName ?? result.error.issues[0]?.path[0];
    throw new AuthInputError(
      400,
      field === "password"
        ? "Password must contain at least 12 characters and at most 1024 UTF-8 bytes."
        : field === "username"
          ? "Username must contain 3–64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number."
          : "Invalid account details.",
    );
  }
  return result.data;
}

/** Derive a password verifier with bounded scrypt memory and work parameters. */
function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, scryptOptions, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Store a salted scrypt verifier, never a plaintext or reversible password. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Compare a supplied password to a saved verifier using constant-time bytes. */
async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(hash);
  if (!match) return false;
  const key = await derivePassword(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}

/** Digest an opaque session token for lookup without retaining the bearer value. */
function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Revalidate an acting account after the account-management lock is held.
 * Lock every needed user before its session so password changes cannot deadlock
 * with account updates; keep authorization stable until the mutation commits.
 */
export async function requireConsoleSession(
  tx: Transaction,
  token: string | undefined,
): Promise<typeof consoleUsers.$inferSelect> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AuthInputError(401, "Sign in to continue.");
  const hash = sessionHash(token);
  const [candidate] = await tx
    .select({ userId: consoleSessions.userId })
    .from(consoleSessions)
    .where(eq(consoleSessions.hash, hash));
  if (!candidate) throw new AuthInputError(401, "Sign in to continue.");
  const [actor] = await tx
    .select()
    .from(consoleUsers)
    .where(eq(consoleUsers.id, candidate.userId))
    .for("share");
  const [session] = await tx
    .select({ expiresAt: consoleSessions.expiresAt })
    .from(consoleSessions)
    .where(
      and(
        eq(consoleSessions.hash, hash),
        eq(consoleSessions.userId, candidate.userId),
      ),
    )
    .for("share");
  // Check the clock after awaited locks, which may outlast the token's validity.
  if (!actor?.enabled || !session || session.expiresAt.getTime() <= Date.now())
    throw new AuthInputError(401, "Sign in to continue.");
  if (actor.mustChangePassword)
    throw new AuthInputError(403, "Change your password to continue.");
  return actor;
}

/** Revalidate a live session and restrict instance management to super admins. */
export async function requireAdministratorSession(
  tx: Transaction,
  token: string | undefined,
): Promise<typeof consoleUsers.$inferSelect> {
  const actor = await requireConsoleSession(tx, token);
  if (actor.role !== "super_admin")
    throw new AuthInputError(403, "Super administrator access required.");
  return actor;
}

/** Sanitize database failures that may include bound password or token values. */
function persistenceError(error: unknown): never {
  if (error instanceof AuthInputError) throw error;
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const pg = cause as { code?: string; constraint?: string } | null;
  if (pg?.code === "23505" && pg.constraint === "console_users_username_unique")
    throw new AuthInputError(409, "This username is already registered.");
  throw new Error("Unable to access saved accounts.");
}

/** Derive current personal and organization repository access without exposing secrets. */
async function userView(
  tx: Transaction,
  row: typeof consoleUsers.$inferSelect,
): Promise<ConsoleUserView> {
  const grants = await accessibleRepositoryIds(tx, row);
  return {
    id: row.publicId,
    ...(row.username === null ? {} : { username: row.username }),
    displayName:
      row.displayName ??
      row.username ??
      row.email ??
      "Identity provider account",
    ...(row.email === null ? {} : { email: row.email }),
    role: row.role,
    enabled: row.enabled,
    authenticationMethod: row.oidcIssuer === null ? "local" : "oidc",
    ...(row.oidcIssuer === null ? {} : { oidcIssuer: row.oidcIssuer }),
    mustChangePassword: row.mustChangePassword,
    repositoryIds: grants,
  };
}

/** Issue a seven-day session while opportunistically removing expired tokens. */
async function issueSession(
  tx: Transaction,
  row: typeof consoleUsers.$inferSelect,
): Promise<ConsoleSession> {
  const now = new Date();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
  await tx.delete(consoleSessions).where(
    inArray(
      consoleSessions.hash,
      tx
        .select({ hash: consoleSessions.hash })
        .from(consoleSessions)
        .where(sql`${consoleSessions.expiresAt} <= ${now}`)
        // Cleanup must not wait on sessions held by account mutations.
        .for("update", { skipLocked: true }),
    ),
  );
  await tx.insert(consoleSessions).values({
    hash: sessionHash(token),
    userId: row.id,
    expiresAt,
  });
  return { user: await userView(tx, row), token, expiresAt };
}

/**
 * Create the initial administrator once under a shared account-management lock.
 * An unset bootstrap password falls back to admin and forces a password change;
 * later restarts preserve all accounts and ignore bootstrap configuration.
 */
export async function bootstrapAdministrator(
  database: Database,
): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(748321, 14)`);
      const [existing] = await tx
        .select({ id: consoleUsers.id })
        .from(consoleUsers)
        .limit(1);
      if (existing) {
        await assignLegacyContexts(tx);
        return;
      }
      const username = parseInput(
        usernameSchema,
        process.env.RAZBOR_ADMIN_USERNAME ?? "admin",
        "username",
      );
      const configured = process.env.RAZBOR_ADMIN_PASSWORD || undefined;
      const password =
        configured === undefined
          ? "admin"
          : parseInput(passwordSchema, configured, "password");
      const [row] = await tx
        .insert(consoleUsers)
        .values({
          publicId: publicId("user"),
          username,
          passwordHash: await hashPassword(password),
          role: "super_admin",
          mustChangePassword: configured === undefined,
        })
        .returning();
      await ensurePersonalContext(tx, row);
      await assignLegacyContexts(tx);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Authenticate enabled local accounts and issue a session, rejecting a concurrent
 * password reset before any token is stored. Unknown usernames do equal work.
 */
export async function authenticateUser(
  database: Database,
  username: string,
  password: string,
): Promise<ConsoleSession | undefined> {
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success || Buffer.byteLength(password, "utf8") > 1024)
    return undefined;
  try {
    const [candidate] = await database.db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, parsed.data));
    const valid = await verifyPassword(
      password,
      candidate?.passwordHash ?? dummyPasswordHash,
    );
    if (!candidate?.enabled || candidate.oidcIssuer !== null || !valid)
      return undefined;
    return await database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(consoleUsers)
        .where(eq(consoleUsers.id, candidate.id))
        .for("update");
      if (
        !row?.enabled ||
        row.oidcIssuer !== null ||
        row.passwordHash !== candidate.passwordHash
      )
        return undefined;
      return issueSession(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Bind a verified provider identity to its own account and refresh its profile and role.
 * Never link local accounts by provider names or email. Preserve administrator
 * disablement and repository grants; role changes revoke every prior session,
 * while profile updates retain sessions. Provider names and email are labels.
 * The caller must verify the issuer and subject before invoking this function.
 */
export async function authenticateOidcUser(
  database: Database,
  input: AuthenticateOidcUserInput,
): Promise<ConsoleSession | undefined> {
  const request = parseInput(oidcUserSchema, input);
  try {
    return await database.transaction(async (tx) => {
      // Share the account-management lock so first logins and role changes
      // serialize with bootstrap and administrator account updates.
      await tx.execute(sql`select pg_advisory_xact_lock(748321, 14)`);
      const [existing] = await tx
        .select()
        .from(consoleUsers)
        .where(
          and(
            eq(consoleUsers.oidcIssuer, request.issuer),
            eq(consoleUsers.oidcSubject, request.subject),
          ),
        )
        .for("update");
      if (existing && !existing.enabled) return undefined;
      let row = existing;
      if (!row) {
        [row] = await tx
          .insert(consoleUsers)
          .values({
            publicId: publicId("user"),
            username: null,
            displayName: request.displayName ?? null,
            email: request.email ?? null,
            oidcIssuer: request.issuer,
            oidcSubject: request.subject,
            passwordHash: null,
            role: request.role,
            mustChangePassword: false,
          })
          .returning();
      } else {
        const roleChanged = row.role !== request.role;
        [row] = await tx
          .update(consoleUsers)
          .set({
            role: request.role,
            displayName: request.displayName ?? null,
            email: request.email ?? null,
            updatedAt: new Date(),
          })
          .where(eq(consoleUsers.id, row.id))
          .returning();
        // Provider demotion remains authoritative even for the last admin.
        if (roleChanged)
          await tx
            .delete(consoleSessions)
            .where(eq(consoleSessions.userId, row.id));
      }
      await ensurePersonalContext(tx, row);
      if (row.role === "super_admin") await assignLegacyContexts(tx);
      return issueSession(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Resolve an unexpired session to the account's current role and grants. */
export async function getSessionUser(
  database: Database,
  token: string,
): Promise<ConsoleUserView | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  try {
    return await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ user: consoleUsers })
        .from(consoleSessions)
        .innerJoin(consoleUsers, eq(consoleUsers.id, consoleSessions.userId))
        .where(
          and(
            eq(consoleSessions.hash, sessionHash(token)),
            gt(consoleSessions.expiresAt, new Date()),
            eq(consoleUsers.enabled, true),
          ),
        )
        .for("share", { of: consoleUsers });
      return row ? userView(tx, row.user) : undefined;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Revoke the current bearer session without retaining or logging its token. */
export async function revokeSession(
  database: Database,
  token: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  try {
    await database.db
      .delete(consoleSessions)
      .where(eq(consoleSessions.hash, sessionHash(token)));
  } catch (error) {
    return persistenceError(error);
  }
}

/** List account identities and grants for administrator account management. */
export async function listUsers(
  database: Database,
): Promise<ConsoleUserView[]> {
  try {
    return await database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(consoleUsers)
        .orderBy(
          asc(
            sql`coalesce(${consoleUsers.displayName}, ${consoleUsers.username}, ${consoleUsers.email}, 'Identity provider account')`,
          ),
        );
      const users: ConsoleUserView[] = [];
      // PostgreSQL transaction clients execute one query at a time.
      for (const row of rows) users.push(await userView(tx, row));
      return users;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Create an account with a temporary password under a live administrator session. */
export async function createUser(
  database: Database,
  input: unknown,
  actorSessionToken: string | undefined,
): Promise<ConsoleUserView> {
  const request = parseInput(createUserSchema, input);
  const passwordHash = await hashPassword(request.password);
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(748321, 14)`);
      await requireAdministratorSession(tx, actorSessionToken);
      const [row] = await tx
        .insert(consoleUsers)
        .values({
          publicId: publicId("user"),
          username: request.username,
          passwordHash,
          role: request.role,
          mustChangePassword: true,
        })
        .returning();
      await ensurePersonalContext(tx, row);
      return userView(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Update an account and revoke existing sessions. Serialize administrator
 * removal, revalidating the live actor to preserve authorization and prevent
 * self-lockout or removal of the last active super administrator. Provider
 * accounts permit only enablement changes through this interface.
 */
export async function updateUser(
  database: Database,
  id: string,
  input: unknown,
  actorSessionToken: string | undefined,
): Promise<ConsoleUserView> {
  if (!publicIdSchema("user").safeParse(id).success)
    throw new AuthInputError(404, "Account not found.");
  const request = parseInput(updateUserSchema, input);
  const passwordHash =
    request.password === undefined
      ? undefined
      : await hashPassword(request.password);
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(748321, 14)`);
      const [current] = await tx
        .select()
        .from(consoleUsers)
        .where(eq(consoleUsers.publicId, id))
        .for("update");
      const actor = await requireAdministratorSession(tx, actorSessionToken);
      if (!current) throw new AuthInputError(404, "Account not found.");
      if (
        current.oidcIssuer !== null &&
        (request.password !== undefined || request.role !== undefined)
      )
        throw new AuthInputError(
          400,
          "Password and role are managed by the identity provider.",
        );
      const enabled = request.enabled ?? current.enabled;
      const role = request.role ?? current.role;
      if (actor.publicId === id && (!enabled || role !== "super_admin"))
        throw new AuthInputError(
          409,
          "You cannot disable or demote your own administrator account.",
        );
      if (
        current.enabled &&
        current.role === "super_admin" &&
        (!enabled || role !== "super_admin")
      ) {
        const admins = await tx
          .select({ id: consoleUsers.id })
          .from(consoleUsers)
          .where(
            and(
              eq(consoleUsers.enabled, true),
              eq(consoleUsers.role, "super_admin"),
            ),
          );
        if (admins.length <= 1)
          throw new AuthInputError(
            409,
            "At least one active administrator is required.",
          );
      }
      const [row] = await tx
        .update(consoleUsers)
        .set({
          role,
          enabled,
          ...(passwordHash === undefined
            ? {}
            : { passwordHash, mustChangePassword: true }),
          updatedAt: new Date(),
        })
        .where(eq(consoleUsers.id, current.id))
        .returning();
      await tx
        .delete(consoleSessions)
        .where(eq(consoleSessions.userId, row.id));
      return userView(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/**
 * Validate the current password, replace it and clear the temporary-password
 * flag, then replace every old session with one fresh session atomically.
 * Reject provider accounts whose passwords are not managed by razbor.
 */
export async function changeUserPassword(
  database: Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ConsoleSession> {
  const password = parseInput(passwordSchema, newPassword, "password");
  if (
    !publicIdSchema("user").safeParse(userId).success ||
    Buffer.byteLength(currentPassword, "utf8") > 1024
  )
    throw new AuthInputError(401, "Current password is incorrect.");
  const passwordHash = await hashPassword(password);
  try {
    return await database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(consoleUsers)
        .where(eq(consoleUsers.publicId, userId))
        .for("update");
      if (current && current.oidcIssuer !== null)
        throw new AuthInputError(
          400,
          "Password is managed by the identity provider.",
        );
      if (
        !current?.enabled ||
        current.passwordHash === null ||
        !(await verifyPassword(currentPassword, current.passwordHash))
      )
        throw new AuthInputError(401, "Current password is incorrect.");
      if (currentPassword === password)
        throw new AuthInputError(400, "Choose a different password.");
      const [row] = await tx
        .update(consoleUsers)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(eq(consoleUsers.id, current.id))
        .returning();
      await tx
        .delete(consoleSessions)
        .where(eq(consoleSessions.userId, row.id));
      return issueSession(tx, row);
    });
  } catch (error) {
    return persistenceError(error);
  }
}
