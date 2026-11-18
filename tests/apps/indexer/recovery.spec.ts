import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  beginAttempt,
  createReviewWorkspace,
  ensureDevelopmentWorkspaces,
  issueToken,
  ownedWorkspaces,
  requestRepositoryDeletion,
  resolveRepository,
  submitReview,
} from "@razbor/database";
import { applyRegistry, registrySchema } from "@razbor/database/registry";
import { indexerConfigSchema } from "@razbor/indexer/config";
import { IndexService } from "@razbor/indexer/service";

import { eventually } from "@tests/apps/indexer/fixtures.js";
import { databaseFixture } from "@tests/packages/database/fixture.js";

test("source-only recovery quarantines invalid checkouts and preserves occupied daemon runtimes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await databaseFixture();
  const { database, administrator } = state;
  const admin = randomBytes(32).toString("base64url");
  const config = indexerConfigSchema.parse({
    service: {
      host: "127.0.0.1",
      port: 0,
      data_root: path.join(root, "data"),
      management_token: { env: "UNUSED_FIXTURE_ADMIN" },
    },
  });
  const { owner, data_root: dataRoot } = config.service;
  const registration = {
    git: {
      branch: "master",
      upstream: "refs/remotes/origin/master",
      remotes: { origin: pathToFileURL(path.join(root, "upstream.git")).href },
      allow_local: true,
    },
    indexing: { owner, persistent: true },
  };
  let service: IndexService | undefined;
  const occupancy = createServer();
  try {
    await applyRegistry(
      database,
      registrySchema.parse({
        registry: { key: "recovery" },
        repositories: {
          source: { ...registration, codebaseMemoryEnabled: false },
          formerIndex: registration,
        },
      }),
    );
    await ensureDevelopmentWorkspaces(database, owner, dataRoot);
    const [index] = await ownedWorkspaces(database, owner);
    await mkdir(index.root, { recursive: true, mode: 0o700 });
    const indexSentinel = path.join(index.root, "retain");
    await writeFile(indexSentinel, "existing checkout");
    const statePath = path.join(index.root, "state");
    // This is the deployed v0.11.0 workspace-specific IPC namespace.
    const runtime = path.join(
      "/tmp",
      "rdm-" +
        createHash("sha256").update(statePath).digest("hex").slice(0, 20),
    );
    await mkdir(runtime, { mode: 0o700 });
    t.after(() =>
      rmdir(runtime).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    );
    const socket = path.join(runtime, "fixture.sock");
    occupancy.listen(socket);
    await once(occupancy, "listening");
    const repositoryId = await resolveRepository(database, "source");
    assert.ok(repositoryId);
    const revisions = {
      repositoryId,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    /** Persist a leftover attempt checkout without executing a review. */
    const allocate = async () => {
      const review = await submitReview(database, revisions);
      const attempt = await beginAttempt(database, review.id, "fixture", 60000);
      assert.equal(attempt.kind, "started");
      return createReviewWorkspace(database, owner, dataRoot, {
        ...revisions,
        reviewId: review.id,
        attemptId: attempt.attemptId,
        ttlMs: 60000,
      });
    };
    const invalid = await allocate();
    const valid = await allocate();
    await mkdir(valid.root, { recursive: true });
    const grant = await issueToken(database, invalid.id, owner, {
      refresh: false,
    });
    const oldRoot = path.join(root, "old-storage", invalid.id);
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(oldRoot, "retain"), "unrelated checkout");
    await administrator.query(
      "update index_workspaces set root=$1 where public_id=$2",
      [oldRoot, invalid.id],
    );

    service = new IndexService(config, admin, database);
    const port = await service.listen();
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    assert.equal(health.status, 200);
    const rows = await ownedWorkspaces(database, owner);
    assert.equal(rows.find((w) => w.id === invalid.id)?.state, "deleting");
    assert.ok(!rows.some((w) => w.id === valid.id));
    assert.equal(rows.find((w) => w.id === index.id)?.state, "unready");
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${grant.token}` },
        })
      ).status,
      401,
    );
    assert.equal(await readFile(indexSentinel, "utf8"), "existing checkout");
    await access(socket);
    await assert.rejects(access(valid.root), { code: "ENOENT" });

    // Retiring a retained checkout can finish even with a populated IPC
    // namespace. Actual deletion must await proof the daemon is gone.
    await service.close();
    await requestRepositoryDeletion(database, index.repositoryId, {
      confirmation: "formerIndex",
    });
    service = new IndexService(
      indexerConfigSchema.parse({
        ...config,
        memory: { executable: path.join(root, "missing-binary") },
      }),
      admin,
      database,
    );
    await service.listen();
    assert.equal(
      (await ownedWorkspaces(database, owner)).find((w) => w.id === index.id)
        ?.state,
      "deleting",
    );
    assert.equal(await readFile(indexSentinel, "utf8"), "existing checkout");
    await access(socket);

    // Repair only the invalid binding and release the fixture listener. The
    // reaper retries both durable deletions without a configured graph binary.
    await administrator.query(
      "update index_workspaces set root=$1 where public_id=$2",
      [invalid.root, invalid.id],
    );
    await new Promise<void>((resolve, reject) =>
      occupancy.close((error) => (error ? reject(error) : resolve())),
    );
    await eventually(
      async () => !(await ownedWorkspaces(database, owner)).length,
    );
    await assert.rejects(access(runtime), { code: "ENOENT" });
    await assert.rejects(access(index.root), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(oldRoot, "retain"), "utf8"),
      "unrelated checkout",
    );
  } finally {
    if (occupancy.listening)
      await new Promise<void>((resolve) => occupancy.close(() => resolve()));
    try {
      await service?.close();
    } finally {
      await state.close();
    }
  }
});
