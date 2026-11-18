import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { gitEnvironment } from "@razbor/harness/git";

const exec = promisify(execFile);

/** Bound the entire poll, including an in-flight predicate, and cancel its I/O on expiry. */
export async function eventually(
  check: (signal: AbortSignal) => Promise<boolean>,
  timeout = 30000,
) {
  const deadline = performance.now() + timeout;
  const controller = new AbortController();
  const { signal } = controller;
  const error = new Error("fixture condition deadline exceeded");
  const timer = setTimeout(() => controller.abort(error), timeout);
  const expired = once(signal, "abort").then(() => {
    throw error;
  });
  /** Stop at the deadline even when a synchronous part of the predicate delayed the timer. */
  async function poll() {
    for (;;) {
      signal.throwIfAborted();
      const ready = await check(signal);
      if (performance.now() >= deadline) throw error;
      if (ready) return;
      await delay(100, undefined, { signal });
    }
  }
  try {
    await Promise.race([expired, poll()]);
  } finally {
    clearTimeout(timer);
  }
}

// Only temporary test repositories use these plumbing operations. No working-tree
// index is staged and the razbor checkout is never committed or reconfigured.
/** Run Git plumbing with fixed fixture identity and a deadline, returning trimmed stdout. */
export async function fixtureGit(
  repository: string,
  args: string[],
  input?: string,
) {
  const child = exec("git", ["-C", repository, ...args], {
    env: {
      ...gitEnvironment,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    timeout: 10000,
  });
  child.child.stdin?.end(input);
  return (await child).stdout.trim();
}

/** Create a bare temporary upstream with master as its initial branch and no Git templates. */
export async function fixtureUpstream(repository: string) {
  await mkdir(repository);
  await fixtureGit(repository, [
    "init",
    "--bare",
    "--initial-branch=master",
    "--template=",
  ]);
}

/** Write a complete fixture tree and commit directly to the selected ref without using a working-tree index. */
export async function fixtureCommit(
  repository: string,
  files: Record<string, string>,
  parent?: string,
  ref = "refs/heads/master",
) {
  const rows: string[] = [];
  for (const [name, text] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const blob = await fixtureGit(
      repository,
      ["hash-object", "-w", "--stdin"],
      text,
    );
    rows.push(`100644 blob ${blob}\t${name}\n`);
  }
  const tree = await fixtureGit(repository, ["mktree"], rows.join(""));
  const sha = await fixtureGit(
    repository,
    ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
    "temporary integration fixture\n",
  );
  await fixtureGit(repository, ["update-ref", ref, sha]);
  return sha;
}
