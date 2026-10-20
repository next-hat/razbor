import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/publish-images.sh", import.meta.url),
);

/** Replace Docker and Git with deterministic argv recorders in a disposable directory. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-publish-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "docker.jsonl");
  await writeFile(
    path.join(root, "docker"),
    `#!${process.execPath}
require('node:fs').appendFileSync(process.env.RAZBOR_FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2))+'\\n');
`,
  );
  await writeFile(
    path.join(root, "git"),
    `#!${process.execPath}
if(process.argv.includes('rev-parse'))process.stdout.write('fixture-revision');
`,
  );
  await chmod(path.join(root, "docker"), 0o755);
  await chmod(path.join(root, "git"), 0o755);
  /** Run the real release script while every Docker invocation stays inside the recorder. */
  const run = async (args: string[], tag?: string) => {
    await writeFile(log, "");
    const result = spawnSync("/bin/bash", [script, ...args], {
      env: {
        PATH: [root, "/usr/bin", "/bin"].join(path.delimiter),
        RAZBOR_FAKE_DOCKER_LOG: log,
        ...(tag === undefined ? {} : { RAZBOR_IMAGE_TAG: tag }),
      },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 100000,
    });
    const docker = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line): string[] => JSON.parse(line));
    return { ...result, docker };
  };
  return { run };
}

test("image publication refuses an implicit release tag before invoking Docker", async (t) => {
  const f = await fixture(t);
  for (const tag of [undefined, ""]) {
    const result = await f.run(["--push", "web"], tag);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /explicit.*tag|--tag.*RAZBOR_IMAGE_TAG/i);
    assert.deepEqual(result.docker, []);
  }
  for (const args of [
    ["--push", "--tag"],
    ["--push", "--tag", "", "web"],
  ]) {
    const result = await f.run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(result.docker, []);
  }
});

test("explicit CLI and environment release tags select the recorded push destination", async (t) => {
  const f = await fixture(t);
  for (const [args, envTag, expected] of [
    [["--push", "--tag", "0.2.0", "web"], undefined, "0.2.0"],
    [["--push", "web"], "0.3.0", "0.3.0"],
    [["--push", "--tag", "0.4.0", "web"], "0.3.0", "0.4.0"],
    [["--push", "--tag", "0.1.0", "web"], undefined, "0.1.0"],
  ] as const) {
    const result = await f.run([...args], envTag);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.docker[0], ["buildx", "version"]);
    assert.equal(result.docker.length, 2);
    const build = result.docker[1];
    assert.ok(build.includes("--push"));
    assert.equal(
      build[build.indexOf("--tag") + 1],
      `ghcr.io/next-hat/razbor-web:${expected}`,
    );
  }
});

test("local image loads retain their template tag without publishing", async (t) => {
  const f = await fixture(t);
  const result = await f.run(["web"]);
  assert.equal(result.status, 0, result.stderr);
  const build = result.docker[1];
  assert.ok(build.includes("--load"));
  assert.ok(!build.includes("--push"));
  assert.equal(
    build[build.indexOf("--tag") + 1],
    "ghcr.io/next-hat/razbor-web:0.1.0",
  );
});
