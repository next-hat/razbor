import { createHash, randomBytes } from "node:crypto";

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  publicIdSchema,
  runnerCreateSchema,
  runnerUpdateSchema,
  runnerSessionSchema,
  type RunnerSession,
  type RunnerView,
} from "@razbor/contracts";

import type { Database, Transaction } from "@database/src/connection.js";
import { requireAdministratorSession } from "@database/src/auth.js";
import { publicId } from "@database/src/ids.js";
import {
  repositories,
  runners,
  runnerRepositories,
} from "@database/src/schema.js";

const enrollmentTtlMs = 15 * 60 * 1000;

const sessionTtlMs = 90000;

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export class RunnerInputError extends Error {
  /**
   * Attach an API-safe validation, authentication or conflict status to a
   * runner error.
   */
  constructor(
    readonly status: 400 | 401 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validate runner input without exposing submitted credentials in schema error
 * details.
 */
function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new RunnerInputError(400, "Invalid runner details.");
  return parsed.data;
}

/**
 * Validate the runner token format before hashing it for credential lookup or
 * storage.
 */
function hashToken(token: string) {
  if (!tokenSchema.safeParse(token).success)
    throw new RunnerInputError(401, "Invalid runner credential.");
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolve and lock each distinct active repository assignment, rejecting
 * unknown or deleting repositories.
 */
async function assignmentRepositories(tx: Transaction, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            inArray(repositories.publicId, unique),
            eq(repositories.status, "active"),
          ),
        )
        .orderBy(repositories.id)
        .for("share")
    : [];
  if (rows.length !== unique.length)
    throw new RunnerInputError(400, "Choose active, registered repositories.");
  return rows;
}

/** Replace a runner's assignment set within the caller's transaction. */
async function assignRepositories(
  tx: Transaction,
  runnerId: string,
  rows: { id: string }[],
) {
  await tx
    .delete(runnerRepositories)
    .where(eq(runnerRepositories.runnerId, runnerId));
  if (rows.length)
    await tx
      .insert(runnerRepositories)
      .values(rows.map((row) => ({ runnerId, repositoryId: row.id })));
}

/**
 * Assemble secret-free registry views with repository assignments and status
 * derived from session health, state and active reservations.
 */
async function runnerViews(
  db: Database["db"] | Transaction,
  id?: string,
): Promise<RunnerView[]> {
  const rows = await db
    .select({
      runner: runners,
      activeReviews: sql<number>`(select count(*)::integer from review_attempts a where a.runner_id = ${runners.id} and a.runner_session_id = ${runners.sessionId} and a.status = 'running' and a.lease_until > now() and a.deadline > now())`,
    })
    .from(runners)
    .where(id ? eq(runners.publicId, id) : undefined)
    .orderBy(asc(runners.createdAt), asc(runners.publicId));
  const assignments = rows.length
    ? await db
        .select({
          runnerId: runnerRepositories.runnerId,
          repositoryId: repositories.publicId,
        })
        .from(runnerRepositories)
        .innerJoin(
          repositories,
          eq(runnerRepositories.repositoryId, repositories.id),
        )
        .where(
          inArray(
            runnerRepositories.runnerId,
            rows.map(({ runner }) => runner.id),
          ),
        )
    : [];
  return rows.map(({ runner, activeReviews }) => {
    const online =
      !!runner.sessionExpiresAt && runner.sessionExpiresAt > new Date();
    const status: RunnerView["status"] =
      runner.state === "revoked"
        ? "revoked"
        : !runner.credentialHash
          ? "pending"
          : !online
            ? "offline"
            : runner.protocolVersion !== 1
              ? "incompatible"
              : !runner.runtimeReady
                ? "unhealthy"
                : runner.state === "draining"
                  ? "draining"
                  : activeReviews >= runner.capacity
                    ? "busy"
                    : "online";
    return {
      id: runner.publicId,
      name: runner.name,
      state: runner.state,
      status,
      repositoryIds: assignments
        .filter((a) => a.runnerId === runner.id)
        .map((a) => a.repositoryId),
      allRepositories: runner.allRepositories,
      activeReviews,
      capacity: runner.capacity,
      ...(runner.runtimeVersion
        ? { runtimeVersion: runner.runtimeVersion }
        : {}),
      ...(runner.lastSeenAt
        ? { lastSeenAt: runner.lastSeenAt.toISOString() }
        : {}),
      ...(runner.enrolledAt
        ? { enrolledAt: runner.enrolledAt.toISOString() }
        : {}),
      createdAt: runner.createdAt.toISOString(),
      updatedAt: runner.updatedAt.toISOString(),
    };
  });
}

/**
 * List registered runners with current availability and assignments, excluding
 * credential material.
 */
export async function listRunners(database: Database) {
  return runnerViews(database.db);
}

/**
 * Create a runner with explicit assignments or access to all current and future
 * repositories, and return a short-lived one-use enrollment token; store only
 * its hash. Console callers supply a session to recheck super admin access.
 */
export async function createRunner(
  database: Database,
  input: unknown,
  actorSessionToken?: string,
) {
  const request = parseInput(runnerCreateSchema, input);
  const enrollmentToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + enrollmentTtlMs);
  return database.transaction(async (tx) => {
    if (actorSessionToken !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(748321, 14)`);
      await requireAdministratorSession(tx, actorSessionToken);
    }
    const [row] = await tx
      .insert(runners)
      .values({
        publicId: publicId("runner"),
        name: request.name,
        allRepositories: request.allRepositories,
        enrollmentHash: hashToken(enrollmentToken),
        enrollmentExpiresAt: expiresAt,
      })
      .returning();
    await assignRepositories(
      tx,
      row.id,
      await assignmentRepositories(tx, request.repositoryIds),
    );
    const [runner] = await runnerViews(tx, row.publicId);
    return { runner, enrollmentToken, expiresAt: expiresAt.toISOString() };
  });
}

/** Provisioning is a trusted administrative operation, never runner authentication. */
export async function provisionRunner(
  database: Database,
  input: {
    key: string;
    name: string;
    repositories: string[];
    enrollmentToken: string;
  },
) {
  const request = parseInput(
    z
      .object({
        key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        name: runnerCreateSchema.shape.name,
        repositories: z.array(z.string().trim().min(1).max(100)).max(1000),
        enrollmentToken: tokenSchema,
      })
      .strict(),
    input,
  );
  const tokenHash = hashToken(request.enrollmentToken);
  return database.transaction(async (tx) => {
    // Serialize first creation before there is a row to lock. Other registry
    // mutations keep their ordinary row locks and never acquire this lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"razbor:runner:" + request.key}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(runners)
      .where(eq(runners.provisioningKey, request.key))
      .for("update");
    if (existing) {
      if (existing.provisioningHash !== tokenHash)
        throw new RunnerInputError(
          409,
          "Runner registration storage does not match this provisioning key. Restore the registration volume or use a new key for a new runner.",
        );
      const pending =
        existing.state !== "revoked" &&
        !existing.enrolledAt &&
        !existing.credentialHash &&
        existing.enrollmentHash === tokenHash;
      if (pending)
        await tx
          .update(runners)
          .set({
            enrollmentExpiresAt: new Date(Date.now() + enrollmentTtlMs),
          })
          .where(eq(runners.id, existing.id));
      const [runner] = await runnerViews(tx, existing.publicId);
      return {
        runner,
        created: false,
        enrollment: pending
          ? ("ready" as const)
          : existing.credentialHash
            ? ("enrolled" as const)
            : ("action_required" as const),
      };
    }
    // Resolve config keys only on first creation. Later UI changes and deleted
    // assignments must survive restarts of the declarative bootstrap service.
    const keys = [...new Set(request.repositories)];
    const matches = keys.length
      ? await tx
          .select({
            publicId: repositories.publicId,
            configKey: repositories.configKey,
          })
          .from(repositories)
          .where(
            and(
              eq(repositories.status, "active"),
              or(
                inArray(repositories.publicId, keys),
                inArray(repositories.configKey, keys),
              ),
            ),
          )
      : [];
    const ids = keys.map((key) => {
      const isId = publicIdSchema("repository").safeParse(key).success;
      const row = matches.find((row) =>
        isId ? row.publicId === key : row.configKey === key,
      );
      if (!row)
        throw new RunnerInputError(
          400,
          "Runner registration.repositories must contain active repository public IDs or application configuration keys, not repository names. For Compose, list registered repositories with 'docker compose run --rm manage repository list', or use an empty list and assign repositories in Runners > Manage.",
        );
      return row.publicId;
    });
    // Lock repositories before inserting the runner, as other assignment paths do.
    const assignments = await assignmentRepositories(tx, ids);
    const [saved] = await tx
      .insert(runners)
      .values({
        publicId: publicId("runner"),
        name: request.name,
        provisioningKey: request.key,
        provisioningHash: tokenHash,
        enrollmentHash: tokenHash,
        enrollmentExpiresAt: new Date(Date.now() + enrollmentTtlMs),
      })
      .returning();
    await assignRepositories(tx, saved.id, assignments);
    const [runner] = await runnerViews(tx, saved.publicId);
    return { runner, created: true, enrollment: "ready" as const };
  });
}

/**
 * Update runner metadata and repository access under lock; omitted access
 * fields preserve the saved policy. Revocation clears credentials and sessions,
 * and resuming a revoked runner requires new enrollment. Recheck console super
 * admin access before repository and runner locks.
 */
export async function updateRunner(
  database: Database,
  id: string,
  input: unknown,
  actorSessionToken?: string,
) {
  if (!publicIdSchema("runner").safeParse(id).success) return undefined;
  const request = parseInput(runnerUpdateSchema, input);
  return database.transaction(async (tx) => {
    if (actorSessionToken !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(748321, 14)`);
      await requireAdministratorSession(tx, actorSessionToken);
    }
    // Repository deletion locks repository before review/attempt. Acquire these
    // assignment locks before the runner to preserve that order.
    const assignments =
      request.repositoryIds === undefined
        ? undefined
        : await assignmentRepositories(tx, request.repositoryIds);
    const [row] = await tx
      .select()
      .from(runners)
      .where(eq(runners.publicId, id))
      .for("update");
    if (!row) return undefined;
    if (row.state === "revoked" && request.state && request.state !== "revoked")
      throw new RunnerInputError(
        409,
        "Generate a new enrollment token to re-enroll this runner.",
      );
    await tx
      .update(runners)
      .set({
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.allRepositories !== undefined
          ? { allRepositories: request.allRepositories }
          : {}),
        ...(request.state !== undefined ? { state: request.state } : {}),
        ...(request.state === "revoked"
          ? {
              credentialHash: null,
              enrollmentHash: null,
              enrollmentExpiresAt: null,
              sessionId: null,
              sessionExpiresAt: null,
              runtimeReady: false,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(runners.id, row.id));
    if (assignments !== undefined)
      await assignRepositories(tx, row.id, assignments);
    const [runner] = await runnerViews(tx, id);
    return runner;
  });
}

/**
 * Invalidate existing runner credentials and session, re-enable the registry
 * entry and return a fresh enrollment token once, rechecking console super admin access.
 */
export async function rotateRunnerEnrollment(
  database: Database,
  id: string,
  actorSessionToken?: string,
) {
  if (!publicIdSchema("runner").safeParse(id).success) return undefined;
  const enrollmentToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + enrollmentTtlMs);
  return database.transaction(async (tx) => {
    if (actorSessionToken !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(748321, 14)`);
      await requireAdministratorSession(tx, actorSessionToken);
    }
    const [row] = await tx
      .update(runners)
      .set({
        state: "enabled",
        enrollmentHash: hashToken(enrollmentToken),
        enrollmentExpiresAt: expiresAt,
        credentialHash: null,
        sessionId: null,
        sessionExpiresAt: null,
        runtimeReady: false,
        updatedAt: new Date(),
      })
      .where(eq(runners.publicId, id))
      .returning();
    if (!row) return undefined;
    const [runner] = await runnerViews(tx, id);
    return { runner, enrollmentToken, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Expose live session identity and advertised capabilities without credential
 * hashes.
 */
function sessionView(row: typeof runners.$inferSelect) {
  return {
    runnerId: row.publicId,
    sessionId: row.sessionId!,
    sessionExpiresAt: row.sessionExpiresAt!.toISOString(),
    state: row.state,
    capacity: row.capacity,
    runtimeReady: row.runtimeReady,
    protocolVersion: row.protocolVersion,
    runtimeVersion: row.runtimeVersion,
    timeoutMs: row.timeoutMs,
    fallbackModel: row.fallbackModel,
  };
}

/**
 * Atomically consume a valid enrollment token and create the first session,
 * returning the permanent credential only in this response.
 */
export async function consumeRunnerEnrollment(
  database: Database,
  input: unknown,
) {
  const request = parseInput(
    runnerSessionSchema.extend({ token: tokenSchema }).strict(),
    input,
  );
  const credential = randomBytes(32).toString("base64url");
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(runners)
      .where(eq(runners.enrollmentHash, hashToken(request.token)))
      .for("update");
    if (
      !row ||
      row.state === "revoked" ||
      !row.enrollmentExpiresAt ||
      row.enrollmentExpiresAt <= new Date()
    )
      throw new RunnerInputError(
        401,
        "Enrollment token is invalid, expired, or already used.",
      );
    const session = runnerSessionSchema.parse({
      sessionId: request.sessionId,
      capacity: request.capacity,
      runtimeReady: request.runtimeReady,
      protocolVersion: request.protocolVersion,
      runtimeVersion: request.runtimeVersion,
      timeoutMs: request.timeoutMs,
      fallbackModel: request.fallbackModel,
    });
    const now = new Date();
    const [saved] = await tx
      .update(runners)
      .set({
        ...session,
        enrollmentHash: null,
        enrollmentExpiresAt: null,
        credentialHash: hashToken(credential),
        enrolledAt: now,
        lastSeenAt: now,
        updatedAt: now,
        sessionExpiresAt: new Date(now.getTime() + sessionTtlMs),
      })
      .where(eq(runners.id, row.id))
      .returning();
    return { ...sessionView(saved), credential };
  });
}

/**
 * Refresh session metadata under a credential lock, rejecting competing live
 * processes and preventing heartbeats from reviving expired sessions.
 */
async function changeSession(
  database: Database,
  credential: string,
  input: unknown,
  heartbeat: boolean,
) {
  const session: RunnerSession = parseInput(runnerSessionSchema, input);
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(runners)
      .where(eq(runners.credentialHash, hashToken(credential)))
      .for("update");
    const now = new Date();
    if (!row || row.state === "revoked")
      throw new RunnerInputError(
        401,
        "Runner credential was revoked or is invalid.",
      );
    const live = !!row.sessionExpiresAt && row.sessionExpiresAt > now;
    if (heartbeat && (!live || row.sessionId !== session.sessionId))
      throw new RunnerInputError(
        401,
        "Runner session expired or was replaced.",
      );
    if (live && row.sessionId !== session.sessionId)
      throw new RunnerInputError(
        409,
        "This runner already has an active process. Stop it or wait for its session to expire.",
      );
    const [saved] = await tx
      .update(runners)
      .set({
        ...session,
        lastSeenAt: now,
        updatedAt: now,
        sessionExpiresAt: new Date(now.getTime() + sessionTtlMs),
      })
      .where(eq(runners.id, row.id))
      .returning();
    return sessionView(saved);
  });
}

/**
 * Authenticate a process session, allowing takeover only after the previous
 * session expires.
 */
export async function openRunnerSession(
  database: Database,
  credential: string,
  input: unknown,
) {
  return changeSession(database, credential, input, false);
}

/**
 * Renew the current live session and its advertised runtime capabilities;
 * expired or replaced sessions must reconnect explicitly.
 */
export async function runnerHeartbeat(
  database: Database,
  credential: string,
  input: unknown,
) {
  return changeSession(database, credential, input, true);
}

/**
 * Require a matching credential and live session, allowing draining runners to
 * finish existing work while rejecting revoked authority.
 */
export async function authenticateRunner(
  database: Database,
  credential: string,
  sessionId: string,
) {
  if (!z.string().uuid().safeParse(sessionId).success)
    throw new RunnerInputError(401, "Invalid runner session.");
  const [row] = await database.db
    .select()
    .from(runners)
    .where(
      and(
        eq(runners.credentialHash, hashToken(credential)),
        eq(runners.sessionId, sessionId),
        sql`${runners.state} <> 'revoked'`,
        sql`${runners.sessionExpiresAt} > now()`,
      ),
    );
  if (!row)
    throw new RunnerInputError(
      401,
      "Runner session is invalid, expired, or revoked.",
    );
  return sessionView(row);
}
