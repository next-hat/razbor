import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const marker = "node_modules/.razbor-lock";

const manifest = JSON.parse(await readFile("package.json", "utf8"));

const packageManager = manifest.packageManager;

if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager ?? ""))
  throw new Error("package.json must pin an exact pnpm version");

const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

for (const directory of ["apps", "packages"]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, "package.json");
    const content = await readFile(file).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content) files.push(file);
  }
}

const hash = createHash("sha256");

for (const file of files.sort())
  hash
    .update(file)
    .update("\0")
    .update(await readFile(file));

const digest = hash.digest("hex");

const previous = await readFile(marker, "utf8").catch(() => "");

if (previous === digest) {
  console.log("Workspace dependencies already match the lockfile.");
} else {
  // Node images provide npm; use it only to bootstrap the pinned pnpm executable.
  const child = spawn(
    "npm",
    [
      "exec",
      "--yes",
      `--package=${packageManager}`,
      "--",
      "pnpm",
      "install",
      "--frozen-lockfile",
    ],
    { stdio: "inherit", env: { ...process.env, CI: "1" } },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) process.exit(typeof code === "number" ? code : 1);
  await writeFile(marker, digest);
}
