import { readdir, lstat } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";
import type { Logger } from "pino";

import type { PreparedCapabilities } from "@razbor/contracts";

import {
  boundedText,
  boundedOutput,
  confinedFile,
} from "@harness/src/capabilities/files.js";

const metadataSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) =>
        Buffer.from(value).toString("utf8") === value &&
        [...value].every((character) => {
          const code = character.charCodeAt(0);
          return code !== 127 && (code >= 32 || [9, 10, 13].includes(code));
        }),
      "Skill descriptions must be readable UTF-8 text",
    ),
});

export const findSkillSchema = z
  .object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const readSkillSchema = z
  .object({ id: z.string().max(64), resource: z.string().max(200).optional() })
  .strict();

/**
 * Parses a skill's required name and description without loading its instructions into
 * a review prompt. Rejects malformed YAML, duplicate keys, and YAML aliases.
 */
export function parseSkillMetadata(text: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front)
    throw new Error("skill requires name/description YAML frontmatter");
  const document = parseDocument(front[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error("malformed skill metadata");
  return metadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
}

export class SkillCatalog {
  private readonly entries = new Map<
    string,
    { name: string; description: string; root: string }
  >();
  private readonly loaded = new Set<string>();

  /** Creates an empty skill catalog with shared discovery, input, and output limits. */
  constructor(
    private readonly limits: PreparedCapabilities["limits"],
    private readonly log: Logger,
  ) {}

  /**
   * Loads bounded skill instructions and validated YAML metadata, rejecting duplicate
   * names, aliases, and catalog overflow.
   */
  private async loadDirectory(directory: string) {
    const text = await boundedText(
      await confinedFile(directory, "SKILL.md"),
      this.limits.skillBytes,
    );
    const metadata = parseSkillMetadata(text);
    if (this.entries.has(metadata.name))
      throw new Error(`duplicate skill identifier: ${metadata.name}`);
    this.entries.set(metadata.name, { ...metadata, root: directory });
    if (this.entries.size > this.limits.skillCount)
      throw new Error("too many approved skills");
  }

  /**
   * Discovers skill directories in deterministic order, rejecting symlink roots or
   * entries and logging only the resulting count.
   */
  async discover(roots: string[]) {
    for (const root of roots) {
      if ((await lstat(root)).isSymbolicLink())
        throw new Error("skill roots must not be symlinks");
      for (const entry of (await readdir(root, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (entry.isSymbolicLink())
          throw new Error("skill symlinks are not allowed");
        if (!entry.isDirectory()) continue;
        const directory = path.join(root, entry.name);
        await this.loadDirectory(directory);
      }
    }
    this.log.info(
      { skillCount: this.entries.size },
      "skill catalog discovered",
    );
  }

  /**
   * Ranks skills by query-word matches in names and descriptions, returning bounded
   * metadata rather than loading instructions.
   */
  find(input: unknown) {
    const { query, limit } = findSkillSchema.parse(input);
    const words = query.toLowerCase().split(/\s+/);
    const matches = [...this.entries.values()]
      .map((entry) => ({
        entry,
        score: words.reduce(
          (score, word) =>
            score +
            (entry.name.includes(word) ? 3 : 0) +
            (entry.description.toLowerCase().includes(word) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
      );
    const skills = matches.slice(0, limit).map(({ entry }) => ({
      id: entry.name,
      name: entry.name,
      description: entry.description,
    }));
    this.log.info(
      { skillIds: skills.map((skill) => skill.id) },
      "skills searched",
    );
    return boundedOutput(
      JSON.stringify({ skills, total: matches.length }),
      this.limits.toolOutputBytes,
    );
  }

  /** Allows approved resource bodies to be delivered again after the model context is replaced. */
  resetContext() {
    this.loaded.clear();
  }

  /**
   * Loads a confined text resource once per context. Rejects oversized instructions
   * rather than truncating them, and marks a resource loaded only after validation.
   */
  async read(input: unknown) {
    const { id, resource = "SKILL.md" } = readSkillSchema.parse(input);
    const entry = this.entries.get(id);
    if (!entry) throw new Error("unknown skill ID");
    if (!/\.(md|txt)$/i.test(resource))
      throw new Error("only Markdown/text skill resources are supported");
    const file = await confinedFile(entry.root, resource);
    const key = `${id}:${resource}`;
    if (this.loaded.has(key))
      return JSON.stringify({ id, resource, alreadyLoaded: true });
    const text = await boundedText(file, this.limits.skillBytes);
    const result = JSON.stringify({ id, resource, instructions: text });
    if (Buffer.byteLength(result) > this.limits.toolOutputBytes)
      throw new Error(
        "skill exceeds tool output limit; increase the operator limit rather than truncating instructions",
      );
    this.loaded.add(key);
    this.log.info(
      { skillId: id, resource, bytes: Buffer.byteLength(text) },
      "skill read",
    );
    return result;
  }
}
