import { z } from "zod";

import { publicIdSchema } from "@contracts/src/ids.js";

export const MAX_SKILL_FILE_BYTES = 131072;

export const MAX_SKILL_BUNDLE_BYTES = 1048576;

export const MAX_SKILL_FILES = 2000;

const utf8 = new TextEncoder();

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Count UTF-8 bytes so browser and server validation share the same limits. */
function textBytes(value: string) {
  return utf8.encode(value).byteLength;
}

/** Reject binary controls and malformed Unicode while allowing text whitespace. */
function isSkillText(value: string) {
  return (
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return (
        code !== 127 && (code >= 32 || code === 9 || code === 10 || code === 13)
      );
    }) && decoder.decode(utf8.encode(value)) === value
  );
}

/** Count files, parent directories, and the skill root used in runner snapshots. */
function skillResources(files: Record<string, string>) {
  const directories = new Set<string>();
  const paths = Object.keys(files);
  for (const file of paths) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++)
      directories.add(parts.slice(0, index).join("/"));
  }
  return 1 + paths.length + directories.size;
}

export const skillResourcePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => textBytes(value) <= 200,
    "Skill resource paths must fit within 200 UTF-8 bytes.",
  )
  .refine(
    (value) =>
      !/[\\\\:]/.test(value) &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      !value.startsWith("/") &&
      decoder.decode(utf8.encode(value)) === value &&
      value.split("/").every((part) => part && part !== "." && part !== "..") &&
      /\.(md|txt)$/i.test(value),
    "Skill resources must use relative Markdown or text paths without traversal.",
  );

export const skillFilesSchema = z
  .record(
    skillResourcePathSchema,
    z
      .string()
      .refine(
        (value) =>
          isSkillText(value) && textBytes(value) <= MAX_SKILL_FILE_BYTES,
        `Skill files must contain UTF-8 text and fit within ${MAX_SKILL_FILE_BYTES} bytes.`,
      ),
  )
  .superRefine((files, ctx) => {
    const paths = Object.keys(files);
    if (!Object.hasOwn(files, "SKILL.md"))
      ctx.addIssue({ code: "custom", message: "SKILL.md is required." });
    // Reserve the managed-skills catalog root in addition to the skill root.
    if (1 + skillResources(files) > MAX_SKILL_FILES)
      ctx.addIssue({ code: "custom", message: "Too many skill resources." });
    if (
      Object.values(files).reduce((total, text) => total + textBytes(text), 0) >
      MAX_SKILL_BUNDLE_BYTES
    )
      ctx.addIssue({ code: "custom", message: "Skill bundle exceeds 1 MiB." });
    const known = new Set(paths);
    if (
      paths.some((file) =>
        file
          .split("/")
          .some((_, index, parts) =>
            known.has(parts.slice(0, index).join("/")),
          ),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "A skill resource cannot also be a directory.",
      });
  });

export const skillBundleSchema = z.object({ files: skillFilesSchema }).strict();

export type SkillBundle = z.infer<typeof skillBundleSchema>;

export const skillSnapshotSchema = z
  .object({
    id: publicIdSchema("skill"),
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: z
      .string()
      .min(1)
      .max(1000)
      .refine(isSkillText, "Skill descriptions must contain valid text."),
    version: z.number().int().positive(),
    files: skillFilesSchema,
  })
  .strict();

export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;

export type SkillView = Omit<SkillSnapshot, "files"> & {
  createdAt: string;
  updatedAt: string;
};

export type SkillDetail = SkillView & SkillBundle;

export const repositoryGuidanceSchema = z
  .object({
    repositoryInstructions: z.boolean().default(false),
    repositorySkills: z.boolean().default(false),
    skillIds: z.array(publicIdSchema("skill")).max(100).default([]),
    alwaysIncludeSkillIds: z.array(publicIdSchema("skill")).max(100).optional(),
  })
  .strict()
  .refine(
    (value) => new Set(value.skillIds).size === value.skillIds.length,
    "Selected skills must be unique.",
  )
  .refine(
    (value) =>
      new Set(value.alwaysIncludeSkillIds).size ===
        (value.alwaysIncludeSkillIds?.length ?? 0) &&
      (value.alwaysIncludeSkillIds ?? []).every((id) =>
        value.skillIds.includes(id),
      ),
    "Always included skills must be unique and selected for the repository.",
  );

export type RepositoryGuidance = z.infer<typeof repositoryGuidanceSchema>;

export type RepositoryGuidanceView = RepositoryGuidance & {
  configured: boolean;
};

export const reviewGuidanceSnapshotSchema = z
  .object({
    repositoryInstructions: z.boolean().optional(),
    repositorySkills: z.boolean().optional(),
    skills: z.array(skillSnapshotSchema).max(100),
    alwaysIncludeSkillIds: z.array(publicIdSchema("skill")).max(100).optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.skills.map((skill) => skill.id)).size ===
        value.skills.length &&
      new Set(value.skills.map((skill) => skill.name)).size ===
        value.skills.length,
    "Selected skills must have unique identities and names.",
  )
  .refine(
    (value) =>
      new Set(value.alwaysIncludeSkillIds).size ===
        (value.alwaysIncludeSkillIds?.length ?? 0) &&
      (value.alwaysIncludeSkillIds ?? []).every((id) =>
        value.skills.some((skill) => skill.id === id),
      ),
    "Always included skills must be unique and present in the snapshot.",
  )
  .refine(
    (value) =>
      value.skills.reduce(
        (total, skill) =>
          total +
          Object.values(skill.files).reduce(
            (sum, text) => sum + textBytes(text),
            0,
          ),
        0,
      ) <= MAX_SKILL_BUNDLE_BYTES,
    "Selected skill content exceeds 1 MiB.",
  )
  .refine(
    (value) =>
      (value.skills.length ? 1 : 0) +
        value.skills.reduce(
          (total, skill) => total + skillResources(skill.files),
          0,
        ) <=
      MAX_SKILL_FILES,
    "Selected skills contain too many resources.",
  )
  .refine(
    (value) => textBytes(JSON.stringify(value)) <= 7 * MAX_SKILL_BUNDLE_BYTES,
    "Selected skill payload is too large.",
  );

export type ReviewGuidanceSnapshot = z.infer<
  typeof reviewGuidanceSnapshotSchema
>;

export type ReviewGuidanceView = Omit<ReviewGuidanceSnapshot, "skills"> & {
  skills: Omit<SkillSnapshot, "files">[];
};
