import { isDeepStrictEqual } from "node:util";
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { repositoryConfigSchema } from "@razbor/harness/git-policy";
import { git } from "@razbor/harness/git";

import type { Database, Transaction } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import {
  repositories,
  indexWorkspaces,
  indexAccessTokens,
  legacyRevocations,
} from "@database/src/schema.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const legacyStateSchema = z
  .object({
    service: z
      .object({
        data_root: z.string(),
        owner: z.string().default("local-indexer"),
      })
      .passthrough(),
    repositories: z.record(z.string(), repositoryConfigSchema),
    tokens: z
      .array(
        z
          .object({
            id: z.string(),
            repository: z.string(),
            sha256: hashSchema,
            refresh: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .passthrough();

class DryRun extends Error {}

// Call only while the old/new indexing services are stopped and the storage lock
// is held by the importer. Reading never modifies the original files or checkouts.
/**
 * Validate and import legacy workspace mappings, token hashes and revocation
 * tombstones without changing checkouts; dry runs roll back all database
 * writes.
 */
export async function importLegacy(
  database: Database,
  input: unknown,
  apply = false,
) {
  const config = legacyStateSchema.parse(input);
  const root = config.service.data_root;
  if (!path.isAbsolute(root) || (await realpath(root)) !== root)
    throw new Error("legacy root must be canonical");
  /**
   * Read a legacy state directory, treating an absent directory as empty while
   * preserving other filesystem errors.
   */
  const entries = async (dir: string) =>
    readdir(path.join(root, dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  if ((await entries("reviews")).length)
    throw new Error(
      "legacy temporary workspaces remain; quiesce and clean them with the legacy service before import",
    );
  const development = await entries("development");
  if (development.some((key) => !Object.hasOwn(config.repositories, key)))
    throw new Error(
      "unconfigured legacy workspace; restore its policy before import",
    );
  const raw = await readFile(
    path.join(root, "revoked-tokens.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const revoked = z.array(hashSchema).parse(JSON.parse(raw));
  const heads = new Map<string, string>();
  for (const key of development) {
    const directory = path.join(root, "development", key);
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error("unsafe legacy workspace");
    const source = path.join(directory, "repository");
    // Preserve checked-out revision; no fetching, cleaning, resetting or indexing.
    const head = await git(source, ["rev-parse", "--verify", "HEAD"]);
    heads.set(key, head);
  }
  let mappings: {
    kind: "workspace" | "token";
    legacyId: string;
    id: string;
  }[] = [];
  /**
   * Map legacy development workspaces to registered repositories, preserving
   * checkout revisions and rejecting owner, policy or existing mapping
   * conflicts.
   */
  async function importWorkspaces(
    tx: Transaction,
    workspaceIds: Map<string, string>,
  ) {
    for (const [key, policy] of Object.entries(config.repositories)) {
      const [repo] = await tx
        .select()
        .from(repositories)
        .where(eq(repositories.configKey, key))
        .for("update");
      if (
        !repo ||
        repo.indexOwner !== config.service.owner ||
        !isDeepStrictEqual(repo.git, policy) ||
        !repo.persistent
      )
        throw new Error("legacy repository registration conflict");
      const legacyKey = `dev:${key}`;
      const directory = path.join(root, "development", key);
      const [existing] = await tx
        .select()
        .from(indexWorkspaces)
        .where(
          and(
            eq(indexWorkspaces.repositoryId, repo.id),
            eq(indexWorkspaces.temporary, false),
          ),
        )
        .for("update");
      if (
        existing &&
        (existing.owner !== config.service.owner ||
          existing.root !== directory ||
          existing.legacyKey !== legacyKey)
      )
        throw new Error("legacy workspace mapping conflict");
      const [workspace] = existing
        ? [existing]
        : await tx
            .insert(indexWorkspaces)
            .values({
              publicId: publicIdSchema("workspace").safeParse(legacyKey).success
                ? legacyKey
                : publicId("workspace"),
              repositoryId: repo.id,
              owner: config.service.owner,
              root: directory,
              temporary: false,
              git: policy,
              legacyKey,
              headSha: heads.get(key) ?? null,
            })
            .returning();
      workspaceIds.set(key, workspace.id);
      mappings.push({
        kind: "workspace",
        legacyId: legacyKey,
        id: workspace.publicId,
      });
    }
  }

  /**
   * Reuse or create legacy token mappings only when hash, workspace and
   * permissions agree, preserving recorded revocations.
   */
  async function importTokens(
    tx: Transaction,
    workspaceIds: Map<string, string>,
  ) {
    for (const token of config.tokens) {
      const workspaceId = workspaceIds.get(token.repository);
      if (!workspaceId) throw new Error("legacy token repository conflict");
      const [existing] = await tx
        .select()
        .from(indexAccessTokens)
        .where(eq(indexAccessTokens.hash, token.sha256))
        .for("update");
      const [sameKey] = await tx
        .select()
        .from(indexAccessTokens)
        .where(
          and(
            eq(indexAccessTokens.workspaceId, workspaceId),
            eq(indexAccessTokens.legacyKey, token.id),
          ),
        );
      if (
        (sameKey && sameKey.hash !== token.sha256) ||
        (existing &&
          (existing.workspaceId !== workspaceId ||
            existing.legacyKey !== token.id ||
            existing.refresh !== token.refresh))
      )
        throw new Error("legacy token mapping conflict");
      const [row] = existing
        ? [existing]
        : await tx
            .insert(indexAccessTokens)
            .values({
              publicId: publicIdSchema("token").safeParse(token.id).success
                ? token.id
                : publicId("token"),
              workspaceId,
              hash: token.sha256,
              refresh: token.refresh,
              legacyKey: token.id,
              revokedAt: revoked.includes(token.sha256) ? new Date() : null,
            })
            .returning();
      mappings.push({ kind: "token", legacyId: token.id, id: row.publicId });
    }
  }

  try {
    await database.transaction(async (tx) => {
      mappings = [];
      await tx.execute(sql`select pg_advisory_xact_lock(748321, 3)`);
      for (const hash of revoked)
        await tx
          .insert(legacyRevocations)
          .values({ hash })
          .onConflictDoNothing();
      const workspaceIds = new Map<string, string>();
      await importWorkspaces(tx, workspaceIds);
      await importTokens(tx, workspaceIds);
      // Never clear an existing revocation or expiry, including on repeated import.
      await tx
        .update(indexAccessTokens)
        .set({ revokedAt: sql`coalesce(${indexAccessTokens.revokedAt},now())` })
        .where(
          sql`${indexAccessTokens.hash} in (select hash from ${legacyRevocations})`,
        );
      if (!apply) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  return {
    applied: apply,
    workspaces: Object.keys(config.repositories).length,
    tokens: config.tokens.length,
    revocations: revoked.length,
    ...(apply ? { mappings } : {}),
  };
}
