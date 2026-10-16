import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// Deliberately watch trusted sources only, never workspaces/results/dependencies.
let child: ChildProcess;

let dirty = false;

let stopping = false;

/**
 * Launch the runner with the current CLI arguments; restart after an intentional
 * source-change stop, but exit on an unexpected child failure.
 */
function start() {
  child = spawn(
    process.execPath,
    ["--import=tsx", "apps/runner/src/index.ts", ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  child.once("exit", () => {
    if (stopping) process.exit(0);
    if (dirty) {
      dirty = false;
      start();
    } else process.exit(1);
  });
}

const directories = [
  "apps/runner/src",
  "apps/agent/src",
  "packages/harness/src",
  "packages/contracts/src",
];

/**
 * Fingerprint trusted TypeScript and Markdown paths using file metadata so polling detects
 * edits, additions, and removals on shared mounts.
 */
async function sourceVersion() {
  const files = (
    await Promise.all(
      directories.map(async (directory) =>
        (await readdir(directory, { recursive: true }))
          .filter((file) => file.endsWith(".ts") || file.endsWith(".md"))
          .map((file) => path.join(directory, file)),
      ),
    )
  )
    .flat()
    .sort();
  return (
    await Promise.all(
      files.map(async (file) => {
        const info = await stat(file, { bigint: true });
        return `${file}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
      }),
    )
  ).join("\n");
}

// Host edits on Kata shared mounts do not reliably emit guest inotify events.
// Poll trusted source metadata, including new/deleted files, without touching jobs.
let version = await sourceVersion();

let polling = false;

const timer = setInterval(async () => {
  if (polling || stopping) return;
  polling = true;
  try {
    const next = await sourceVersion();
    if (next !== version) {
      version = next;
      if (!dirty) {
        dirty = true;
        console.info("Runner source changed; restarting with current code");
        child.kill("SIGTERM");
      }
    }
  } catch {
    console.warn("Runner source scan unavailable; retrying");
  } finally {
    polling = false;
  }
}, 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
    clearInterval(timer);
    child.kill("SIGTERM");
  });

start();
