import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import {
  repositoryGuidanceSchema,
  reviewGuidanceSnapshotSchema,
  skillBundleSchema,
  type RepositoryGuidance,
  type SkillSnapshot,
} from "@razbor/contracts";
import { parseSkillMetadata } from "@razbor/harness/skills";

import type { Transaction } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import { repositories, skills } from "@database/src/schema.js";

const defaultGuideDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "defaults",
);

/** Read the account's surviving default guide without recreating a deleted copy. */
export async function defaultReviewGuide(
  tx: Pick<Transaction, "select">,
  contextId: string | null | undefined,
): Promise<SkillSnapshot | undefined> {
  if (!contextId) return undefined;
  const [guide] = await tx
    .select({
      id: skills.publicId,
      name: skills.name,
      description: skills.description,
      version: skills.version,
      files: skills.files,
    })
    .from(skills)
    .where(
      and(eq(skills.contextId, contextId), eq(skills.defaultReviewGuide, true)),
    )
    .for("share");
  return guide;
}

/** Seed a newly created account once, preserving same-named user and legacy skills. */
export async function seedDefaultReviewGuide(
  tx: Transaction,
  contextId: string,
) {
  const original = await readFile(
    path.join(defaultGuideDirectory, "core-review-guide.md"),
    "utf8",
  );
  const metadata = parseSkillMetadata(original);
  const existing = await tx
    .select({ name: skills.name })
    .from(skills)
    .where(or(eq(skills.contextId, contextId), isNull(skills.contextId)));
  const names = new Set(existing.map((skill) => skill.name));
  let name = metadata.name;
  for (let suffix = 2; names.has(name); suffix++)
    name = `${metadata.name}-${suffix}`;
  const files = skillBundleSchema.parse({
    files: { "SKILL.md": original.replace(/^name: .+$/m, `name: ${name}`) },
  }).files;
  await tx.insert(skills).values({
    publicId: publicId("skill"),
    contextId,
    name,
    description: metadata.description,
    files,
    defaultReviewGuide: true,
  });
}

/**
 * Add the seeded guide to explicitly configured legacy repositories after ownership
 * binding, retaining existing selections and skipping policies that exceed limits.
 */
export async function addDefaultGuideToRepositories(
  tx: Transaction,
  contextId: string,
  repositoryIds: string[],
) {
  if (!repositoryIds.length) return;
  const guide = await defaultReviewGuide(tx, contextId);
  if (!guide) return;
  const rows = await tx
    .select({ id: repositories.id, guidance: repositories.guidance })
    .from(repositories)
    .where(
      and(
        eq(repositories.contextId, contextId),
        inArray(repositories.id, repositoryIds),
      ),
    )
    .for("update");
  let skipped = 0;
  for (const repository of rows) {
    if (!repository.guidance) continue;
    const existing = repositoryGuidanceSchema.safeParse(repository.guidance);
    if (!existing.success) {
      skipped++;
      continue;
    }
    const policy = repositoryGuidanceSchema.safeParse({
      ...existing.data,
      skillIds: [...new Set([...existing.data.skillIds, guide.id])],
      alwaysIncludeSkillIds: [
        ...new Set([...(existing.data.alwaysIncludeSkillIds ?? []), guide.id]),
      ],
    });
    if (!policy.success) {
      skipped++;
      continue;
    }
    const selected = await tx
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
          eq(skills.contextId, contextId),
          inArray(skills.publicId, policy.data.skillIds),
        ),
      )
      .orderBy(asc(skills.publicId))
      .for("share");
    if (
      selected.length !== policy.data.skillIds.length ||
      !reviewGuidanceSnapshotSchema.safeParse({
        repositoryInstructions: policy.data.repositoryInstructions,
        repositorySkills: policy.data.repositorySkills,
        alwaysIncludeSkillIds: policy.data.alwaysIncludeSkillIds,
        skills: selected,
      }).success
    ) {
      skipped++;
      continue;
    }
    await tx
      .update(repositories)
      .set({
        guidance: policy.data satisfies RepositoryGuidance,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id));
  }
  if (skipped)
    console.warn(
      `Default review guide available but not assigned to ${skipped} legacy repository policies that exceed guidance limits or contain unavailable skills.`,
    );
}
