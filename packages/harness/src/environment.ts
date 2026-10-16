import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { git } from "@harness/src/git.js";

const commandNames = [
  "git",
  "rg",
  "node",
  "npm",
  "pnpm",
  "cargo",
  "rustc",
  "go",
  "python3",
];

/**
 * Checks executable files only on the caller-approved PATH. It never runs repository
 * scripts, toolchain shims, package managers or installers during preflight.
 */
async function commandAvailable(name: string, searchPath: string) {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Missing or inaccessible PATH entries do not establish tool availability.
    }
  }
  return false;
}

/**
 * Reports basic verification prerequisites from the pinned root tree and trusted PATH.
 * Availability is not a successful build: versions, dependencies, writable output and
 * network access must still be verified by actual commands within the sandbox.
 */
export async function inspectReviewEnvironment(
  repository: string,
  head: string,
  env: Record<string, string | undefined> = {},
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const rootFiles = new Set(
    (await git(repository, ["ls-tree", "--name-only", head], signal)).split(
      "\n",
    ),
  );
  const commands = await Promise.all(
    commandNames.map(async (name) => ({
      name,
      available: await commandAvailable(name, env.PATH ?? "/usr/bin:/bin"),
    })),
  );
  signal?.throwIfAborted();
  const detectedProjects: string[] = [];
  const required: string[] = [];
  if (rootFiles.has("Cargo.toml")) {
    detectedProjects.push("Rust");
    required.push("cargo", "rustc");
  }
  if (rootFiles.has("package.json")) {
    detectedProjects.push("Node.js");
    required.push("node");
    if (rootFiles.has("pnpm-lock.yaml")) required.push("pnpm");
    else if (rootFiles.has("package-lock.json")) required.push("npm");
  }
  if (rootFiles.has("go.mod")) {
    detectedProjects.push("Go");
    required.push("go");
  }
  if (rootFiles.has("pyproject.toml") || rootFiles.has("requirements.txt")) {
    detectedProjects.push("Python");
    required.push("python3");
  }
  const missing = commands.filter(
    ({ name, available }) => required.includes(name) && !available,
  );
  return {
    commands,
    detectedProjects,
    limitations: [
      ...missing.map(
        ({ name }) =>
          `${name} is unavailable on the approved executable PATH; checks requiring it have not run.`,
      ),
      "Preflight checks executable presence only. It does not verify versions, dependencies, nested projects, successful compilation or test results.",
      "The review sandbox mounts the checkout read-only. Commands needing writes or executable build outputs may be unavailable; report their actual result and never infer a passing check.",
    ],
  };
}
