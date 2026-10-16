import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "@razbor/harness/git";

/** Create a temporary repository with two revisions and helpers for diff scenarios; callers must close it. */
export async function diffFixture() {
  const repository = await mkdtemp(path.join(os.tmpdir(), "razbor-diff-"));
  /** Write fixture content relative to the temporary repository root. */
  const write = (name: string, content: string | Buffer) =>
    writeFile(path.join(repository, name), content);
  /** Optionally stage fixture changes, commit them with a fixed identity, and return the new HEAD SHA. */
  const commit = async (stage = true) => {
    if (stage) await git(repository, ["add", "--all"]);
    await git(repository, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "temporary diff fixture",
    ]);
    return git(repository, ["rev-parse", "HEAD"]);
  };
  try {
    await git(repository, ["init", "--template="]);
    await write("source.ts", "old implementation\nstable context\n");
    await write("related.ts", "related unchanged\n");
    const base = await commit();
    await write("source.ts", "new implementation 💡\nstable context\n");
    const head = await commit();
    return {
      repository,
      base,
      head,
      write,
      commit,
      /** Remove the temporary repository and all files created by this fixture. */
      close: () => rm(repository, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}
