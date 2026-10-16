import { mkdir, readdir, lstat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  preparedCapabilitiesSchema,
  skillResourcePathSchema,
  type QueueJob,
} from "@razbor/contracts";
import { git } from "@razbor/harness/git";
import { boundedText } from "@razbor/harness/capability-files";
import { parseSkillMetadata } from "@razbor/harness/skills";

import type { ResolvedConfig } from "@runner/src/config.js";
import type { Workspace } from "@runner/src/workspace.js";

type GitEntry = { mode: string; kind: string; object: string; file: string };

/** Rejects ambiguous paths and oversized filesystem components before copying resources. */
function validateRelativePath(file: string) {
  if (
    file.length > 1000 ||
    [...file].some(
      (character) =>
        character === "\\" ||
        character === ":" ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    ) ||
    file
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part) > 255,
      )
  )
    throw new Error("invalid approved resource path");
}

/**
 * Reads a bounded regular Git blob by object ID so filenames cannot alter Git revision
 * syntax. Rejects oversized, binary, and invalid UTF-8 content without truncation.
 */
async function readBaseText(
  repository: string,
  entry: GitEntry,
  limit: number,
  signal: AbortSignal,
) {
  validateRelativePath(entry.file);
  if (!/^100(?:644|755)$/.test(entry.mode) || entry.kind !== "blob")
    throw new Error("approved base material must be a regular file");
  const size = Number(
    await git(repository, ["cat-file", "-s", entry.object], signal),
  );
  if (!Number.isSafeInteger(size) || size < 0 || size > limit)
    throw new Error("approved base material exceeds the configured limit");
  const text = await git(
    repository,
    ["cat-file", "blob", entry.object],
    signal,
    false,
  );
  if (text.includes("\0") || Buffer.byteLength(text) > limit)
    throw new Error("approved base material must be bounded text");
  return text;
}

/**
 * Enumerates the recorded base tree with NUL-separated paths. Git's output cap bounds
 * discovery, and no files from the mutable checkout or pull request head are consulted.
 */
async function baseTree(
  repository: string,
  baseSha: string,
  signal: AbortSignal,
): Promise<GitEntry[]> {
  const listing = await git(
    repository,
    ["ls-tree", "-rz", "--full-tree", baseSha],
    signal,
    false,
  );
  return listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) (\S+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(
        line,
      );
      if (!match) throw new Error("invalid base tree entry");
      return {
        mode: match[1],
        kind: match[2],
        object: match[3],
        file: match[4],
      };
    });
}

/**
 * Snapshots root and nested AGENTS.md instructions with directory scopes. AGENT.md is
 * only a root fallback; nested scopes are ordered after their ancestors.
 */
async function prepareBaseInstructions(
  repository: string,
  baseSha: string,
  entries: GitEntry[],
  root: string,
  prepared: ReturnType<typeof preparedCapabilitiesSchema.parse>,
  signal: AbortSignal,
) {
  const instructions = entries.filter(
    (entry) => path.posix.basename(entry.file) === "AGENTS.md",
  );
  if (!instructions.some((entry) => entry.file === "AGENTS.md")) {
    const fallback = entries.find((entry) => entry.file === "AGENT.md");
    if (fallback) instructions.push(fallback);
  }
  if (instructions.length > 100)
    throw new Error("too many repository instruction files");
  instructions.sort(
    (a, b) =>
      a.file.split("/").length - b.file.split("/").length ||
      a.file.localeCompare(b.file),
  );
  let bytes = 0;
  for (const [index, entry] of instructions.entries()) {
    const scope = path.posix.dirname(entry.file);
    const name = scope === "." ? "base.md" : `instructions-${index}.md`;
    const text = await readBaseText(
      repository,
      entry,
      prepared.limits.instructionBytes,
      signal,
    );
    bytes += Buffer.byteLength(text);
    if (bytes > prepared.limits.instructionBytes)
      throw new Error(
        `repository instruction text exceeds the configured aggregate limit (${prepared.limits.instructionBytes} bytes)`,
      );
    await writeFile(path.join(root, name), text);
    prepared.instructions.push({
      path: `/input/capabilities/${name}`,
      provenance: `${baseSha}:${entry.file}`,
      scope: scope === "." ? "" : scope,
    });
  }
}

/**
 * Copy approved instructions and skill text into the attempt input directory, returning only
 * sandbox-visible paths and provenance.
 */
export async function prepareCapabilities(
  config: Pick<ResolvedConfig, "capabilities">,
  workspace: Pick<Workspace, "root" | "repository">,
  job: QueueJob,
  signal: AbortSignal,
) {
  const policy = config.capabilities;
  const guidance = job.guidance;
  if (!policy && !guidance) return undefined;
  const prepared = preparedCapabilitiesSchema.parse({ limits: policy?.limits });
  const root = path.join(workspace.root, "input", "capabilities");
  await mkdir(root);
  const repositoryInstructions =
    guidance?.repositoryInstructions ?? policy?.base_instructions ?? false;
  const repositorySkills = guidance?.repositorySkills ?? false;
  const entries =
    repositoryInstructions || repositorySkills
      ? await baseTree(workspace.repository, job.baseSha, signal)
      : [];
  if (repositoryInstructions) {
    await prepareBaseInstructions(
      workspace.repository,
      job.baseSha,
      entries,
      root,
      prepared,
      signal,
    );
  }
  if (policy?.instruction_file) {
    const text = await boundedText(
      policy.instruction_file,
      prepared.limits.instructionBytes,
    );
    await writeFile(path.join(root, "operator.md"), text);
    prepared.instructions.push({
      path: "/input/capabilities/operator.md",
      provenance:
        "operator-configured private instruction file (takes precedence over repository instructions)",
    });
  }
  let count = 0;
  let bytes = 0;

  /** Accounts for a bounded text resource shared by all configured skill sources. */
  const accountText = (text: string) => {
    const size = Buffer.byteLength(text);
    if (text.includes("\0") || size > prepared.limits.skillBytes)
      throw new Error("approved skills must be bounded text");
    bytes += size;
    if (bytes > 8_000_000)
      throw new Error("approved skill snapshot exceeds 8 MB");
  };

  /** Counts resources across repository, managed, and operator snapshots. */
  const accountResource = () => {
    if (++count > 2000) throw new Error("too many skill resources");
  };

  const createdDirectories = new Set<string>();

  /** Creates each snapshot directory once, counting it against the shared resource cap. */
  const skillDirectory = async (directory: string) => {
    let current = root;
    for (const part of path.relative(root, directory).split(path.sep)) {
      current = path.join(current, part);
      if (createdDirectories.has(current)) continue;
      accountResource();
      await mkdir(current);
      createdDirectories.add(current);
    }
  };

  /** Writes a validated skill resource while bounding files, directories, and bytes. */
  const writeSkillText = async (target: string, text: string) => {
    signal.throwIfAborted();
    accountResource();
    accountText(text);
    await skillDirectory(path.dirname(target));
    await writeFile(target, text);
  };

  /**
   * Recursively copy bounded Markdown and text skill resources, rejecting symlinks and
   * enforcing aggregate file and byte limits.
   */
  const snapshot = async (source: string, target: string) => {
    signal.throwIfAborted();
    const stat = await lstat(source);
    if (stat.isSymbolicLink())
      throw new Error("approved skill material must not contain symlinks");
    accountResource();
    if (stat.isDirectory()) {
      await mkdir(target);
      for (const name of await readdir(source))
        await snapshot(path.join(source, name), path.join(target, name));
    } else if (stat.isFile() && /\.(md|txt)$/i.test(source)) {
      const text = await boundedText(source, prepared.limits.skillBytes);
      accountText(text);
      await writeFile(target, text);
    } else if (!stat.isFile()) throw new Error("unsupported skill resource");
  };
  for (const [index, directory] of (
    policy?.skill_directories ?? []
  ).entries()) {
    await snapshot(directory, path.join(root, `skills-${index}`));
    prepared.skills.push(`/input/capabilities/skills-${index}`);
  }

  if (repositorySkills) {
    const prefix = ".agents/skills/";
    const bundles = new Map<string, GitEntry[]>();
    for (const entry of entries) {
      if (
        [".agents", ".agents/skills"].includes(entry.file) &&
        ["120000", "160000"].includes(entry.mode)
      )
        throw new Error(
          "repository skill roots must not be symlinks or submodules",
        );
      if (!entry.file.startsWith(prefix)) continue;
      validateRelativePath(entry.file);
      const relative = entry.file.slice(prefix.length);
      const slash = relative.indexOf("/");
      if (slash === -1) {
        if (["120000", "160000"].includes(entry.mode))
          throw new Error(
            "repository skills must not contain symlinks or submodules",
          );
        continue;
      }
      const name = relative.slice(0, slash);
      const resources = bundles.get(name) ?? [];
      resources.push(entry);
      bundles.set(name, resources);
    }
    if (bundles.size > prepared.limits.skillCount)
      throw new Error("too many repository skills");
    if (bundles.size) {
      const directory = path.join(root, "repository-skills");
      await skillDirectory(directory);
      for (const [name, resources] of [...bundles].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const main = resources.find(
          (entry) => entry.file === `${prefix}${name}/SKILL.md`,
        );
        if (!main) throw new Error("repository skill requires SKILL.md");
        const mainText = await readBaseText(
          workspace.repository,
          main,
          prepared.limits.skillBytes,
          signal,
        );
        parseSkillMetadata(mainText);
        for (const entry of resources) {
          if (!/^100(?:644|755)$/.test(entry.mode) || entry.kind !== "blob")
            throw new Error("repository skill resources must be regular files");
          if (!/\.(md|txt)$/i.test(entry.file)) {
            accountResource();
            continue;
          }
          const resource = entry.file.slice(`${prefix}${name}/`.length);
          if (!skillResourcePathSchema.safeParse(resource).success)
            throw new Error("invalid repository skill resource path");
          const text =
            entry === main
              ? mainText
              : await readBaseText(
                  workspace.repository,
                  entry,
                  prepared.limits.skillBytes,
                  signal,
                );
          const target = path.join(directory, name, resource);
          await writeSkillText(target, text);
        }
      }
      prepared.skills.push("/input/capabilities/repository-skills");
    }
  }

  if (guidance?.skills.length) {
    const directory = path.join(root, "managed-skills");
    await skillDirectory(directory);
    const alwaysInclude = new Set(guidance.alwaysIncludeSkillIds ?? []);
    for (const [index, skill] of guidance.skills.entries()) {
      const metadata = parseSkillMetadata(skill.files["SKILL.md"] ?? "");
      if (
        metadata.name !== skill.name ||
        metadata.description !== skill.description
      )
        throw new Error("managed skill metadata does not match its snapshot");
      for (const [resource, text] of Object.entries(skill.files).sort(
        ([a], [b]) => a.localeCompare(b),
      )) {
        signal.throwIfAborted();
        if (!skillResourcePathSchema.safeParse(resource).success)
          throw new Error("invalid managed skill resource path");
        const target = path.join(directory, `skill-${index}`, resource);
        await writeSkillText(target, text);
      }
      if (alwaysInclude.has(skill.id)) {
        prepared.includedSkills ??= [];
        prepared.includedSkills.push({
          id: skill.id,
          name: skill.name,
          version: skill.version,
          path: `/input/capabilities/managed-skills/skill-${index}/SKILL.md`,
        });
      }
    }
    prepared.skills.push("/input/capabilities/managed-skills");
  }
  return preparedCapabilitiesSchema.parse(prepared);
}
