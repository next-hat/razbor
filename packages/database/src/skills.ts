import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  publicIdSchema,
  repositoryGuidanceSchema,
  reviewGuidanceSnapshotSchema,
  skillBundleSchema,
  type RepositoryGuidance,
  type RepositoryGuidanceView,
  type ReviewGuidanceSnapshot,
  type SkillDetail,
  type SkillView,
} from "@razbor/contracts";
import { parseSkillMetadata } from "@razbor/harness/skills";

import { AuthInputError } from "@database/src/auth.js";
import {
  defaultImportContextId,
  requireContextSession,
  resolveContextId,
} from "@database/src/contexts.js";
import type { Database, Transaction } from "@database/src/connection.js";
import { defaultReviewGuide } from "@database/src/default-review-guide.js";
import { publicId } from "@database/src/ids.js";
import { repositories, skills } from "@database/src/schema.js";

export class SkillInputError extends Error {
  /** Attach an API-safe status to validation and assignment conflicts. */
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Validate a text bundle and derive its metadata from the required SKILL.md. */
function parseBundle(input: unknown) {
  const result = skillBundleSchema.safeParse(input);
  if (!result.success)
    throw new SkillInputError(
      400,
      "Invalid skill bundle. Include SKILL.md and safe Markdown or text resources within the file and bundle limits.",
    );
  try {
    return {
      ...parseSkillMetadata(result.data.files["SKILL.md"]),
      files: result.data.files,
    };
  } catch {
    throw new SkillInputError(
      400,
      "SKILL.md requires valid YAML frontmatter with a lowercase hyphenated name (up to 64 characters) and a description (up to 1000 characters).",
    );
  }
}

/** Hide database details and submitted text while preserving expected conflicts. */
function persistenceError(error: unknown): never {
  if (error instanceof SkillInputError || error instanceof AuthInputError)
    throw error;
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const pg = cause as { code?: string; constraint?: string } | null;
  if (pg?.code === "23505" && pg.constraint === "skills_name_unique")
    throw new SkillInputError(
      409,
      "A skill with this name already exists. Edit it or choose another name in SKILL.md.",
    );
  throw new Error("Unable to access saved skills.");
}

const viewSelection = {
  id: skills.publicId,
  name: skills.name,
  description: skills.description,
  version: skills.version,
  createdAt: skills.createdAt,
  updatedAt: skills.updatedAt,
};

/** Serialize audit timestamps without including resource content in list responses. */
function view(
  row: Omit<SkillView, "createdAt" | "updatedAt"> & {
    createdAt: Date;
    updatedAt: Date;
  },
): SkillView {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List saved skills in stable name order with metadata and content versions. */
export async function listSkills(
  database: Database,
  contextId?: string,
): Promise<SkillView[]> {
  try {
    const rows = await database.db
      .select(viewSelection)
      .from(skills)
      .where(
        contextId === undefined
          ? undefined
          : sql`${skills.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      )
      .orderBy(asc(skills.name), asc(skills.publicId));
    return rows.map(view);
  } catch (error) {
    return persistenceError(error);
  }
}

/** Read a complete editable skill bundle, returning undefined for missing IDs. */
export async function getSkill(
  database: Database,
  id: string,
  contextId?: string,
): Promise<SkillDetail | undefined> {
  if (!publicIdSchema("skill").safeParse(id).success) return undefined;
  try {
    const [row] = await database.db
      .select({ ...viewSelection, files: skills.files })
      .from(skills)
      .where(
        and(
          eq(skills.publicId, id),
          contextId === undefined
            ? undefined
            : sql`${skills.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      );
    return row ? { ...view(row), files: row.files } : undefined;
  } catch (error) {
    return persistenceError(error);
  }
}

/** Save a validated text bundle with metadata derived from its instructions. */
export async function createSkill(
  database: Database,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<SkillDetail> {
  const request = parseBundle(input);
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "skills",
        );
      const ownerId =
        contextId === undefined
          ? await defaultImportContextId(tx)
          : await resolveContextId(tx, contextId);
      const [row] = await tx
        .insert(skills)
        .values({ ...request, contextId: ownerId, publicId: publicId("skill") })
        .returning({ ...viewSelection, files: skills.files });
      return { ...view(row), files: row.files };
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Replace a bundle atomically and increment its version for future submissions. */
export async function updateSkill(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<SkillDetail | undefined> {
  if (!publicIdSchema("skill").safeParse(id).success) return undefined;
  const request = parseBundle(input);
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "skills",
        );
      const [row] = await tx
        .update(skills)
        .set({
          ...request,
          version: sql`${skills.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(skills.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${skills.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .returning({ ...viewSelection, files: skills.files });
      return row ? { ...view(row), files: row.files } : undefined;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Delete an unassigned skill; saved review snapshots continue owning their content. */
export async function deleteSkill(
  database: Database,
  id: string,
  contextId?: string,
  sessionToken?: string,
): Promise<boolean> {
  if (!publicIdSchema("skill").safeParse(id).success) return false;
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "skills",
        );
      // Assignment and submission share-lock selected skills before referencing them.
      const [skill] = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(
          and(
            eq(skills.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${skills.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .for("update");
      if (!skill) return false;
      const [repository] = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          sql`${repositories.guidance}->'skillIds' @> ${JSON.stringify([id])}::jsonb`,
        )
        .limit(1);
      if (repository)
        throw new SkillInputError(
          409,
          "This skill is selected by a repository. Remove its selection before deleting it.",
        );
      await tx.delete(skills).where(eq(skills.id, skill.id));
      return true;
    });
  } catch (error) {
    return persistenceError(error);
  }
}

/** Read saved guidance or the UI defaults without changing legacy repository behavior. */
export async function getRepositoryGuidance(
  database: Database,
  id: string,
  contextId?: string,
): Promise<RepositoryGuidanceView | undefined> {
  if (!publicIdSchema("repository").safeParse(id).success) return undefined;
  try {
    const [repository] = await database.db
      .select({
        guidance: repositories.guidance,
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
      );
    const guide =
      repository?.guidance === null
        ? await defaultReviewGuide(database.db, repository.contextId)
        : undefined;
    return repository
      ? {
          ...repositoryGuidanceSchema.parse(
            repository.guidance ??
              (guide
                ? {
                    skillIds: [guide.id],
                    alwaysIncludeSkillIds: [guide.id],
                  }
                : {}),
          ),
          configured: repository.guidance !== null,
        }
      : undefined;
  } catch (error) {
    return persistenceError(error);
  }
}

/** Pin selected content under shared locks, preserving review behavior after later edits. */
export async function snapshotRepositoryGuidance(
  tx: Transaction,
  guidance: RepositoryGuidance | null,
  contextInternalId: string | null,
): Promise<ReviewGuidanceSnapshot | undefined> {
  if (!guidance) {
    const guide = await defaultReviewGuide(tx, contextInternalId);
    return guide
      ? reviewGuidanceSnapshotSchema.parse({
          skills: [guide],
          alwaysIncludeSkillIds: [guide.id],
        })
      : undefined;
  }
  const policy = repositoryGuidanceSchema.parse(guidance);
  const rows = policy.skillIds.length
    ? await tx
        .select({
          id: skills.publicId,
          name: skills.name,
          description: skills.description,
          version: skills.version,
          files: skills.files,
        })
        .from(skills)
        .where(
          and(
            inArray(skills.publicId, policy.skillIds),
            sql`${skills.contextId} is not distinct from ${contextInternalId}::uuid`,
          ),
        )
        .orderBy(asc(skills.publicId))
        .for("share")
    : [];
  if (rows.length !== policy.skillIds.length)
    throw new SkillInputError(
      409,
      "A selected skill is unavailable. Update the repository's skill selection.",
    );
  const result = reviewGuidanceSnapshotSchema.safeParse({
    repositoryInstructions: policy.repositoryInstructions,
    repositorySkills: policy.repositorySkills,
    alwaysIncludeSkillIds: policy.alwaysIncludeSkillIds,
    skills: rows,
  });
  if (!result.success)
    throw new SkillInputError(
      400,
      "Selected skill content exceeds the review limits or contains an invalid bundle. Update the selected skills.",
    );
  return result.data;
}

/** Save guidance after checking all selected skills belong to the repository account and fit shared limits. */
export async function updateRepositoryGuidance(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
): Promise<RepositoryGuidanceView | undefined> {
  if (!publicIdSchema("repository").safeParse(id).success) return undefined;
  const result = repositoryGuidanceSchema.safeParse(input);
  if (!result.success)
    throw new SkillInputError(
      400,
      "Invalid repository guidance. Choose instruction and skill settings and at most 100 unique saved skills.",
    );
  try {
    return await database.transaction(async (tx) => {
      if (sessionToken !== undefined)
        await requireContextSession(
          tx,
          sessionToken,
          contextId ?? "",
          "skills",
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
            eq(repositories.publicId, id),
            contextId === undefined
              ? undefined
              : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
          ),
        )
        .for("update");
      if (!repository || repository.status !== "active") return undefined;
      await snapshotRepositoryGuidance(tx, result.data, repository.contextId);
      await tx
        .update(repositories)
        .set({ guidance: result.data, updatedAt: new Date() })
        .where(eq(repositories.id, repository.id));
      return { ...result.data, configured: true };
    });
  } catch (error) {
    return persistenceError(error);
  }
}
