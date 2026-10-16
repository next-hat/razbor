import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";

import { publicIdSchema } from "@razbor/contracts";
import {
  connectDatabase,
  listRepositories,
  getRepository,
  submitReview,
  getReview,
  listReviews,
  beginAttempt,
  finishAttempt,
  ensureDevelopmentWorkspaces,
  ownedWorkspaces,
  issueToken,
  revokeToken,
  authorizeHash,
  tokenHash,
  listTokens,
  pendingDispatches,
} from "@razbor/database";
import {
  registrySchema,
  applyRegistry,
  refreshRepository,
} from "@razbor/database/registry";
import { importLegacy } from "@razbor/database/legacy";
import { createQueue, dispatchPending } from "@razbor/queue";

import { databaseFixture } from "@tests/packages/database/fixture.js";

test(
  "durable identities, migration, scope, recovery and no UUID leakage with PostgreSQL/pg-boss",
  { timeout: 90000 },
  async () => {
    const fixture = await databaseFixture();
    const { database: db } = fixture;
    const producer = await createQueue(db);
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-import-test-"));
    let externalId = "90071992547409931234";
    const provider = createServer((_request, response) =>
      response.end(
        `{"id":${externalId},"full_name":"team/renamed","html_url":"${origin}/team/renamed","private":true,"archived":false}`,
      ),
    );
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const git = {
        branch: "main",
        upstream: "refs/remotes/origin/main",
        remotes: { origin: "https://example.invalid/team/project.git" },
      };
      const config = registrySchema.parse({
        registry: { key: "test" },
        forges: {
          a: {
            type: "forgejo",
            api_url: `${origin}/api/v1`,
            web_url: origin,
            allow_http: true,
          },
          b: {
            type: "forgejo",
            api_url: `${origin}/other/api/v1`,
            web_url: origin,
            allow_http: true,
          },
        },
        repositories: {
          fixture: { git, indexing: { owner: "fixture", persistent: true } },
          other: { git, indexing: { owner: "fixture", persistent: true } },
          hosted: {
            forge: "a",
            selector: "team/project",
            git,
            indexing: { owner: "fixture", persistent: false },
          },
          second: {
            forge: "b",
            selector: "team/project",
            git,
            indexing: { owner: "fixture", persistent: false },
          },
        },
      });
      await applyRegistry(db, config);
      const initial = await listRepositories(db);
      await applyRegistry(db, config);
      assert.deepEqual(await listRepositories(db), initial);
      const repository = initial.find((r) => r.configKey === "fixture")!;
      const hosted = initial.find((r) => r.configKey === "hosted")!;
      const second = initial.find((r) => r.configKey === "second")!;
      assert.notEqual(hosted.forgeId, second.forgeId);
      await refreshRepository(db, hosted.id);
      await refreshRepository(db, second.id);
      config.repositories.hosted.selector = "team/renamed";
      await applyRegistry(db, config);
      await refreshRepository(db, hosted.id);
      assert.equal(
        (await getRepository(db, hosted.id))!.metadata!.externalRepositoryId,
        externalId,
      );
      externalId = "3";
      await assert.rejects(refreshRepository(db, hosted.id));
      assert.equal(
        (await getRepository(db, hosted.id))!.externalRepositoryId,
        "90071992547409931234",
      );
      const changed = structuredClone(config);
      changed.repositories.hosted.forge = "b";
      await assert.rejects(applyRegistry(db, changed));
      const unauthorized = structuredClone(config);
      unauthorized.registry.key = "manual-conflict";
      await assert.rejects(applyRegistry(db, unauthorized));
      const secret = randomBytes(32).toString("base64url");
      const revokedSecret = randomBytes(32).toString("base64url");
      const conformingTokenId = "tok_ABCDEFGHIJKLMNOP";
      await mkdir(path.join(root, "development"));
      await mkdir(path.join(root, "reviews"));
      await writeFile(
        path.join(root, "revoked-tokens.json"),
        JSON.stringify([tokenHash(revokedSecret)]),
      );
      const legacy = {
        service: { data_root: root, owner: "fixture" },
        repositories: { fixture: config.repositories.fixture.git },
        tokens: [
          {
            id: conformingTokenId,
            repository: "fixture",
            sha256: tokenHash(secret),
            refresh: true,
          },
          {
            id: "revoked",
            repository: "fixture",
            sha256: tokenHash(revokedSecret),
            refresh: false,
          },
        ],
      };
      assert.equal((await importLegacy(db, legacy)).applied, false);
      assert.equal((await ownedWorkspaces(db, "fixture")).length, 0);
      const report = await importLegacy(db, legacy, true);
      const again = await importLegacy(db, legacy, true);
      assert.deepEqual(again.mappings, report.mappings);
      assert.equal(
        (await authorizeHash(db, tokenHash(secret), "fixture")).id,
        conformingTokenId,
      );
      await assert.rejects(
        authorizeHash(db, tokenHash(revokedSecret), "fixture"),
      );
      await assert.rejects(
        authorizeHash(db, tokenHash(secret), "another-owner"),
      );
      const oldFile = await readFile(
        path.join(root, "revoked-tokens.json"),
        "utf8",
      );
      await revokeToken(db, conformingTokenId);
      await importLegacy(db, legacy, true);
      await assert.rejects(authorizeHash(db, tokenHash(secret), "fixture"));
      assert.equal(
        await readFile(path.join(root, "revoked-tokens.json"), "utf8"),
        oldFile,
      );
      await ensureDevelopmentWorkspaces(db, "fixture", root);
      const workspaces = await ownedWorkspaces(db, "fixture");
      const workspace = workspaces.find(
        (w) => w.repositoryId === repository.id,
      )!;
      const token = await issueToken(db, workspace.id, "fixture", {
        refresh: true,
        ttlMs: 1000,
      });
      const grant = await authorizeHash(db, tokenHash(token.token), "fixture");
      assert.equal(grant.workspace, workspace.id);
      assert.notEqual(
        grant.workspace,
        workspaces.find((w) => w.id !== workspace.id)!.id,
      );
      await fixture.administrator.query(
        "update index_access_tokens set expires_at = now() - interval '1 second' where public_id = $1",
        [token.id],
      );
      await assert.rejects(
        authorizeHash(db, tokenHash(token.token), "fixture"),
      );
      const accepted = await submitReview(db, {
        repositoryId: repository.id,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      });
      assert.ok(publicIdSchema("review").safeParse(accepted.id).success);
      const intent = (await pendingDispatches(db))[0];
      // The queue accepted the job, but the dispatcher crashed before its outbox acknowledgement.
      const queuedId = await producer.send("reviews", intent, {
        singletonKey: intent.reviewId,
      });
      assert.ok(queuedId);
      await dispatchPending(db, producer);
      assert.equal(
        (await producer.findJobs("reviews", { key: intent.reviewId })).length,
        1,
      );
      assert.equal((await pendingDispatches(db)).length, 0);
      const first = await beginAttempt(db, accepted.id, "runner", 10000);
      assert.equal(first.kind, "started");
      if (first.kind !== "started") throw new Error();
      assert.equal(
        (await beginAttempt(db, accepted.id, "other", 10000)).kind,
        "busy",
      );
      await fixture.administrator.query(
        "update review_attempts set lease_until = now() - interval '1 second' where public_id=$1",
        [first.attemptId],
      );
      const next = await beginAttempt(db, accepted.id, "runner", 10000);
      assert.equal(next.kind, "started");
      if (next.kind !== "started") throw new Error();
      const result = { summary: "Validated durable result", findings: [] };
      await assert.rejects(
        finishAttempt(db, accepted.id, first.attemptId, "runner", result),
      );
      await finishAttempt(db, accepted.id, next.attemptId, "runner", result);
      await assert.rejects(
        finishAttempt(
          db,
          accepted.id,
          next.attemptId,
          "runner",
          undefined,
          true,
        ),
      );
      await producer.deleteJob("reviews", queuedId);
      assert.deepEqual((await getReview(db, accepted.id))!.review, result);
      assert.equal(
        (await beginAttempt(db, accepted.id, "runner", 10000)).kind,
        "completed",
      );
      const restart = connectDatabase(fixture.url);
      try {
        assert.deepEqual(
          await getReview(restart, accepted.id),
          await getReview(db, accepted.id),
        );
      } finally {
        await restart.close();
      }
      const internal = await fixture.administrator.query<{ id: string }>(
        "select id from forge_instances union all select id from repositories union all select id from reviews union all select id from review_attempts union all select id from index_workspaces union all select id from index_access_tokens",
      );
      const serialized = JSON.stringify({
        repositories: await listRepositories(db),
        reviews: await listReviews(db),
        tokens: await listTokens(db, "fixture"),
      });
      for (const { id } of internal.rows) {
        assert.ok(!serialized.includes(id), "internal UUID leaked");
        await assert.rejects(getReview(db, id));
        await assert.rejects(getRepository(db, id));
      }
      const pk = await fixture.administrator.query<{
        table_name: string;
        data_type: string;
      }>(
        "select table_name,data_type from information_schema.columns where table_schema='public' and column_name='id'",
      );
      assert.equal(pk.rows.length, 23);
      assert.ok(pk.rows.every((r) => r.data_type === "uuid"));
      const fk = await fixture.administrator.query<{ typname: string }>(
        "select t.typname from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) join pg_type t on a.atttypid=t.oid where c.contype='f' and c.connamespace='public'::regnamespace",
      );
      assert.ok(fk.rows.length >= 7);
      assert.ok(fk.rows.every((r) => r.typname === "uuid"));
      await assert.rejects(db.pool.query("create table forbidden(id uuid)"));
      await assert.rejects(
        db.pool.query("update reviews set public_id=$1 where public_id=$2", [
          "rev_ABCDEFGHIJKLMNOP",
          accepted.id,
        ]),
      );
      const active = await issueToken(db, workspace.id, "fixture", {
        refresh: false,
      });
      await authorizeHash(db, tokenHash(active.token), "fixture");
      await fixture.container.stop();
      await assert.rejects(
        authorizeHash(db, tokenHash(active.token), "fixture"),
      );
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await producer.stop();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
