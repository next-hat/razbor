import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";

import { gitEnvironment } from "@razbor/harness/git";

const exec = promisify(execFile);

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
