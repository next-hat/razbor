import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { publicId } from "@razbor/database/ids";
import { capabilityLimitsSchema } from "@razbor/contracts";
import { git } from "@razbor/harness/git";
import { prepareCapabilities } from "@razbor/runner/capabilities";

test("instruction snapshots use the recorded base and private operator source, never head", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-instructions-"));
  const repository = path.join(root, "repository");
  try {
    await mkdir(repository);
    await mkdir(path.join(root, "input"));
    await git(repository, ["init", "--template="]);
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "Approved base guidance",
    );
    await writeFile(
      path.join(repository, "AGENT.md"),
      "Fallback must not override plural file",
    );
    await git(repository, ["add", "."]);
    /** Commit already-staged fixture files with a fixed identity inside the temporary repository. */
    const commit = () =>
      git(repository, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "temporary fixture",
      ]);
    await commit();
    const baseSha = await git(repository, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "Untrusted head instructions",
    );
    await git(repository, ["add", "."]);
    await commit();
    const headSha = await git(repository, ["rev-parse", "HEAD"]);
    const instruction = path.join(root, "private.md");
    await writeFile(instruction, "Private operator guidance");
    const prepared = await prepareCapabilities(
      {
        capabilities: {
          base_instructions: true,
          instruction_file: instruction,
          skill_directories: [],
          limits: capabilityLimitsSchema.parse({}),
        },
      },
      { root, repository },
      {
        version: 1,
        reviewId: publicId("review"),
        repositoryId: publicId("repository"),
        baseSha,
        headSha,
        submittedAt: new Date().toISOString(),
      },
      new AbortController().signal,
    );
    assert.equal(prepared?.instructions.length, 2);
    assert.equal(
      await readFile(path.join(root, "input/capabilities/base.md"), "utf8"),
      "Approved base guidance",
    );
    assert.equal(
      await readFile(path.join(root, "input/capabilities/operator.md"), "utf8"),
      "Private operator guidance",
    );
    assert.equal(prepared?.instructions[0].provenance, `${baseSha}:AGENTS.md`);
    assert.equal(
      await readFile(path.join(repository, "AGENTS.md"), "utf8"),
      "Untrusted head instructions",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
