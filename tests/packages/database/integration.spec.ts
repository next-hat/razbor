import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";

import {
  codebaseMemoryUnavailableMessage,
  publicIdSchema,
  type ReviewAttemptMetrics,
} from "@razbor/contracts";
import {
  connectDatabase,
  listRepositories,
  getRepository,
  submitReview,
  getReview,
  listReviews,
  beginAttempt,
  finishAttempt,
  recordAttemptMetrics,
  ensureDevelopmentWorkspaces,
  ownedWorkspaces,
  issueToken,
  revokeToken,
  authorizeHash,
  tokenHash,
  listTokens,
  pendingDispatches,
  updateRepositoryCodebaseMemory,
  updateRepositoryReviewTriggerMode,
  createRepositoryFromUi,
  createReviewWorkspace,
  createIndexToken,
  listIndexProjects,
  pendingRepositoryIndexes,
  repositoryIndexSetup,
  reconcileIndexCapability,
  workspaceState,
} from "@razbor/database";
import {
  registrySchema,
  applyRegistry,
  refreshRepository,
} from "@razbor/database/registry";
import { importLegacy } from "@razbor/database/legacy";
import { createQueue, dispatchPending } from "@razbor/queue";

import { databaseFixture } from "@tests/packages/database/fixture.js";

test("registry uses owner-scoped deployment defaults only when creating an undeclared preference", async (t) => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const git = {
    branch: "main",
    upstream: "refs/remotes/origin/main",
    remotes: { origin: "https://example.invalid/repo.git" },
  };
  const local = { git, indexing: { owner: "source" } };
  const config = registrySchema.parse({
    registry: { key: "file" },
    repositories: {
      omitted: local,
      explicit: { ...local, codebaseMemoryEnabled: true },
      other: { git, indexing: { owner: "other" } },
    },
  });
  /** Read the persisted choices by stable registry key after each isolated import. */
  async function choices() {
    return Object.fromEntries(
      (await listRepositories(fixture.database)).map((repo) => [
        repo.configKey,
        repo.codebaseMemoryEnabled,
      ]),
    );
  }
  await applyRegistry(fixture.database, config, "source");
  assert.deepEqual(await choices(), {
    omitted: false,
    explicit: true,
    other: true,
  });
  delete config.repositories.explicit.codebaseMemoryEnabled;
  await applyRegistry(fixture.database, config, "other");
  assert.deepEqual(await choices(), {
    omitted: false,
    explicit: true,
    other: true,
  });
  config.repositories.omitted.codebaseMemoryEnabled = true;
  config.repositories.explicit.codebaseMemoryEnabled = false;
  config.repositories.legacy = config.repositories.other;
  await applyRegistry(fixture.database, config);
  assert.deepEqual(await choices(), {
    omitted: true,
    explicit: false,
    other: true,
    legacy: true,
  });
});

test("bundle recovery retries only affected persistent setup and preserves unrelated repository states", async (t) => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const db = fixture.database;
  const owner = "indexer";
  const git = {
    branch: "main",
    upstream: "refs/remotes/origin/main",
    remotes: { origin: "https://example.invalid/repo.git" },
  };
  const project = { git, indexing: { owner } };
  await applyRegistry(
    db,
    registrySchema.parse({
      registry: { key: "outage" },
      repositories: {
        persistent: project,
        onDemand: { git, indexing: { owner, persistent: false } },
        published: project,
        running: project,
        unrelated: project,
        disabled: { ...project, codebaseMemoryEnabled: false },
        foreign: { git, indexing: { owner: "other" } },
      },
    }),
  );
  const { administrator } = fixture;
  await administrator.query(
    "UPDATE repositories SET setup_state='pending' WHERE config_key IN ('persistent','onDemand','disabled','foreign')",
  );
  await administrator.query(
    "UPDATE repositories SET setup_state='indexing' WHERE config_key='running'",
  );
  await administrator.query(
    "UPDATE repositories SET setup_state='error', setup_error='Verify repository access.' WHERE config_key='unrelated'",
  );
  /** Snapshot setup values and timestamps so repeated polling must leave matching rows untouched. */
  const snapshot = async () =>
    (
      await administrator.query(
        "SELECT config_key, setup_state, setup_error, updated_at::text FROM repositories ORDER BY config_key",
      )
    ).rows;
  const before = await snapshot();
  const keys = before.map((row) => row.config_key);
  await reconcileIndexCapability(db, owner, false);
  const unavailable = await snapshot();
  assert.deepEqual(
    unavailable.map((row) => row.config_key),
    keys,
  );
  for (const [index, row] of unavailable.entries()) {
    if (["persistent", "onDemand"].includes(row.config_key))
      assert.deepEqual(
        [row.setup_state, row.setup_error],
        ["error", codebaseMemoryUnavailableMessage],
      );
    else assert.deepEqual(row, before[index]);
  }
  await reconcileIndexCapability(db, owner, false);
  assert.deepEqual(await snapshot(), unavailable);
  await reconcileIndexCapability(db, owner, true);
  const recovered = await snapshot();
  assert.deepEqual(
    recovered.map((row) => row.config_key),
    keys,
  );
  for (const [index, row] of recovered.entries()) {
    if (row.config_key === "persistent" || row.config_key === "onDemand")
      assert.deepEqual(
        [row.setup_state, row.setup_error],
        [row.config_key === "persistent" ? "pending" : "ready", null],
      );
    else assert.deepEqual(row, before[index]);
  }
  await reconcileIndexCapability(db, owner, true);
  assert.deepEqual(await snapshot(), recovered);

  const repos = await listRepositories(db);
  const persistent = repos.find((repo) => repo.configKey === "persistent");
  const onDemand = repos.find((repo) => repo.configKey === "onDemand");
  assert.ok(persistent && onDemand);
  for (const repo of [persistent, onDemand]) {
    await repositoryIndexSetup(db, owner, repo.id, "indexing");
    assert.equal(
      await repositoryIndexSetup(db, owner, repo.id, "interrupted"),
      true,
    );
    assert.equal(
      (await getRepository(db, repo.id))?.setupState,
      repo.persistent ? "pending" : "ready",
    );
    assert.equal(
      await repositoryIndexSetup(db, owner, repo.id, "interrupted"),
      false,
    );
  }
  assert.deepEqual(await pendingRepositoryIndexes(db, owner), [
    { id: persistent.id },
  ]);
});

test("repository settings fence index grants while preserving an active attempt's source and index policy", async (t) => {
  const fixture = await databaseFixture();
  const db = fixture.database;
  const owner = "fixture";
  const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
  const root = "/fixture/data";
  try {
    const config = registrySchema.parse({
      registry: { key: "ui" },
      repositories: {
        project: {
          git: {
            branch: "main",
            upstream: "refs/remotes/origin/main",
            remotes: { origin: "https://example.invalid/repo.git" },
          },
          indexing: { owner },
        },
      },
    });
    await applyRegistry(db, config);
    const [repo] = await listRepositories(db);
    assert.equal(repo.codebaseMemoryEnabled, true);
    assert.equal(repo.codebaseMemoryEditable, false);
    assert.equal(repo.reviewTriggerMode, "manual");
    assert.equal(repo.reviewTriggerModeEditable, false);
    await assert.rejects(
      updateRepositoryReviewTriggerMode(db, repo.id, {
        reviewTriggerMode: "automatic",
      }),
      /registry file/,
    );
    config.repositories.project.reviewTriggerMode = "automatic";
    await applyRegistry(db, config);
    assert.equal(
      (await getRepository(db, repo.id))?.reviewTriggerMode,
      "automatic",
    );
    delete config.repositories.project.reviewTriggerMode;
    await applyRegistry(db, config);
    assert.equal(
      (await getRepository(db, repo.id))?.reviewTriggerMode,
      "manual",
    );
    await assert.rejects(
      updateRepositoryCodebaseMemory(db, repo.id, {
        codebaseMemoryEnabled: false,
      }),
      /registry file/,
    );
    await ensureDevelopmentWorkspaces(db, owner, root);
    const [workspace] = await ownedWorkspaces(db, owner);
    const grant = await createIndexToken(db, workspace.id, true);
    const request = { repositoryId: repo.id, ...revision };
    const indexedReview = await submitReview(db, request);
    const indexed = await beginAttempt(db, indexedReview.id, owner, 60000);
    assert.ok(indexed.kind === "started" && indexed.codebaseMemoryEnabled);
    const queued = await submitReview(db, request);
    assert.equal(
      await repositoryIndexSetup(db, owner, repo.id, "indexing"),
      true,
    );
    config.repositories.project.codebaseMemoryEnabled = false;
    await applyRegistry(db, config);
    const [project] = await listIndexProjects(db, repo.id);
    assert.deepEqual(
      [
        project.state,
        project.indexedAt,
        project.headSha,
        project.canCreateToken,
      ],
      ["disabled", null, null, false],
    );
    assert.deepEqual(await pendingRepositoryIndexes(db, owner), []);
    await assert.rejects(authorizeHash(db, tokenHash(grant.token), owner));
    await assert.rejects(createIndexToken(db, workspace.id, false));
    await assert.rejects(ensureDevelopmentWorkspaces(db, owner, root, repo.id));
    const lease = {
      ...request,
      reviewId: indexedReview.id,
      attemptId: indexed.attemptId,
      ttlMs: 60000,
    };
    const pinned = await createReviewWorkspace(db, owner, root, lease);
    assert.equal(pinned.codebaseMemoryEnabled, true);
    // The shared graph tracks its own branch, which can be behind the PR head.
    await workspaceState(
      db,
      owner,
      pinned.id,
      "ready",
      revision.headSha,
      undefined,
      revision.baseSha,
    );
    assert.equal(
      await repositoryIndexSetup(db, owner, repo.id, "indexing"),
      false,
    );
    await ensureDevelopmentWorkspaces(
      db,
      owner,
      root,
      repo.id,
      indexed.attemptId,
    );
    assert.equal(
      await repositoryIndexSetup(
        db,
        owner,
        repo.id,
        "indexing",
        undefined,
        pinned.git,
        indexed.attemptId,
      ),
      true,
    );
    assert.equal((await getRepository(db, repo.id))!.setupState, "ready");
    const source = await beginAttempt(db, queued.id, owner, 60000);
    assert.ok(source.kind === "started" && !source.codebaseMemoryEnabled);
    await assert.rejects(
      ensureDevelopmentWorkspaces(db, owner, root, repo.id, source.attemptId),
    );
    // Re-enable while the pinned attempt owns preparation, before it publishes readiness.
    config.repositories.project.codebaseMemoryEnabled = true;
    await applyRegistry(db, config);
    await workspaceState(db, owner, workspace.id, "ready", revision.baseSha);
    /** Publish the result of the still-running preparation at its recorded graph revision. */
    const finishSharedSetup = (headSha: string) =>
      repositoryIndexSetup(
        db,
        owner,
        repo.id,
        "ready",
        undefined,
        pinned.git,
        indexed.attemptId,
        {
          project: workspace.id,
          headSha,
        },
      );
    assert.equal(await finishSharedSetup(revision.headSha), false);
    assert.equal((await getRepository(db, repo.id))?.setupState, "pending");
    assert.equal(await finishSharedSetup(revision.baseSha), true);
    assert.equal((await getRepository(db, repo.id))?.setupState, "ready");
    config.repositories.project.codebaseMemoryEnabled = false;
    await applyRegistry(db, config);
    await finishAttempt(db, indexedReview.id, indexed.attemptId, owner, {
      summary: "Fixture complete",
      findings: [],
    });
    await assert.rejects(
      ensureDevelopmentWorkspaces(db, owner, root, repo.id, indexed.attemptId),
    );
    config.repositories.project.codebaseMemoryEnabled = true;
    await applyRegistry(db, config);
    assert.deepEqual(await pendingRepositoryIndexes(db, owner), [
      { id: repo.id },
    ]);
    const checkout = await createReviewWorkspace(db, owner, root, {
      ...lease,
      reviewId: queued.id,
      attemptId: source.attemptId,
    });
    assert.equal(checkout.codebaseMemoryEnabled, false);
    await workspaceState(
      db,
      owner,
      checkout.id,
      "ready",
      revision.headSha,
      undefined,
      null,
    );
    await assert.rejects(
      workspaceState(
        db,
        owner,
        workspace.id,
        "ready",
        revision.headSha,
        undefined,
        null,
      ),
    );
    await assert.rejects(
      workspaceState(
        db,
        owner,
        workspace.id,
        "ready",
        revision.headSha,
        undefined,
        revision.baseSha,
      ),
    );
    // An existing index with stale Git policy stays fenced when unrelated
    // workspaces are provisioned at source-service startup.
    config.repositories.project.git.remotes.origin =
      "https://example.invalid/moved.git";
    config.repositories.another = structuredClone(config.repositories.project);
    await applyRegistry(db, config);
    await ensureDevelopmentWorkspaces(db, owner, root);
    assert.equal(
      (await ownedWorkspaces(db, owner)).filter((item) => !item.temporary)
        .length,
      2,
    );
    await assert.rejects(
      ensureDevelopmentWorkspaces(db, owner, root, repo.id),
      /policy changed/,
    );
    const repositoryUrl = "https://forge.invalid/team/ui";
    const providerResponses = new Map<string, unknown>([
      ["/api/v3/user", { id: 1, login: "fixture" }],
      [
        "/api/v3/repos/team/ui",
        {
          id: 2,
          full_name: "team/ui",
          html_url: repositoryUrl,
          default_branch: "main",
          private: true,
          archived: false,
          clone_url: `${repositoryUrl}.git`,
        },
      ],
      [
        "/api/v3/repos/team/ui/branches/main",
        { name: "main", commit: { sha: revision.headSha } },
      ],
    ]);
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      assert.equal(url.origin, "https://forge.invalid");
      assert.ok(providerResponses.has(url.pathname));
      return Response.json(providerResponses.get(url.pathname));
    });
    const created = await createRepositoryFromUi(db, {
      forgeType: "github",
      webhookMode: "manual",
      repositoryUrl,
      reviewTriggerMode: "opt_in_continuous",
      accessToken: "local-test-credential",
      permittedSenders: ["fixture"],
      callbackBase: "https://razbor.invalid",
      codebaseMemoryEnabled: false,
    });
    assert.equal(created.codebaseMemoryEnabled, false);
    assert.equal(created.reviewTriggerMode, "opt_in_continuous");
    assert.equal(created.reviewTriggerModeEditable, true);
    await assert.rejects(
      updateRepositoryReviewTriggerMode(
        db,
        created.id,
        { reviewTriggerMode: "automatic" },
        "ctx_ABCDEFGHIJKLMNOP",
      ),
    );
    assert.equal(
      (await getRepository(db, created.id))?.reviewTriggerMode,
      "opt_in_continuous",
    );
    assert.equal(
      (
        await updateRepositoryReviewTriggerMode(db, created.id, {
          reviewTriggerMode: "manual",
        })
      )?.reviewTriggerMode,
      "manual",
    );
    assert.equal(created.setupState, "ready");
    await assert.rejects(
      updateRepositoryCodebaseMemory(
        db,
        created.id,
        { codebaseMemoryEnabled: true },
        "ctx_ABCDEFGHIJKLMNOP",
      ),
    );
    await assert.rejects(
      updateRepositoryCodebaseMemory(db, created.id, {
        codebaseMemoryEnabled: "false",
      }),
    );
    const saved = await updateRepositoryCodebaseMemory(db, created.id, {
      codebaseMemoryEnabled: true,
    });
    assert.ok(saved?.codebaseMemoryEditable && saved.codebaseMemoryEnabled);
    assert.equal(saved.setupState, "pending");
    assert.equal(
      (
        await updateRepositoryCodebaseMemory(db, created.id, {
          codebaseMemoryEnabled: false,
        })
      )?.setupState,
      "ready",
    );
  } finally {
    await fixture.close();
  }
});

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
      assert.equal(
        await recordAttemptMetrics(db, accepted.id, first.attemptId, "runner", {
          inputTokens: 100,
          outputTokens: 20,
          uncachedInputTokens: 50,
          cachedInputTokens: 40,
          cacheWriteTokens: 10,
          modelTurns: 1,
          toolCalls: 3,
          budgetTokens: 120,
          estimatedCostUsd: 0.0003,
          costEstimateComplete: true,
          tokenUsageComplete: true,
        }),
        true,
      );
      assert.equal(
        await recordAttemptMetrics(db, accepted.id, first.attemptId, "runner", {
          inputTokens: 100,
          outputTokens: 20,
          modelTurns: 2,
          toolCalls: 3,
          budgetTokens: 500,
          estimatedCostUsd: 0.0006,
          costEstimateComplete: false,
          tokenUsageComplete: false,
        }),
        true,
      );
      // A transport gap never regains precise cache accounting through replayed progress.
      await recordAttemptMetrics(db, accepted.id, first.attemptId, "runner", {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        uncachedInputTokens: 50,
        cacheWriteTokens: 10,
        estimatedCostUsd: 0.0006,
        costEstimateComplete: true,
        tokenUsageComplete: true,
      });
      const storedUsage = await fixture.administrator.query<{
        metrics: ReviewAttemptMetrics;
      }>("select metrics from review_attempts where public_id=$1", [
        first.attemptId,
      ]);
      assert.equal(storedUsage.rows[0].metrics.modelTurns, 2);
      assert.equal(storedUsage.rows[0].metrics.budgetTokens, 500);
      assert.equal(storedUsage.rows[0].metrics.estimatedCostUsd, 0.0006);
      assert.equal(storedUsage.rows[0].metrics.tokenUsageComplete, false);
      assert.equal(storedUsage.rows[0].metrics.costEstimateComplete, false);
      assert.equal(storedUsage.rows[0].metrics.cachedInputTokens, undefined);
      assert.equal(storedUsage.rows[0].metrics.uncachedInputTokens, undefined);
      assert.equal(storedUsage.rows[0].metrics.cacheWriteTokens, undefined);
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
      await recordAttemptMetrics(
        db,
        accepted.id,
        next.attemptId,
        "runner",
        {
          inputTokens: 50,
          outputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 50,
          cacheWriteTokens: 0,
          modelTurns: 1,
          toolCalls: 0,
          budgetTokens: 60,
          estimatedCostUsd: 0.0001,
          costEstimateComplete: true,
          tokenUsageComplete: true,
        },
        true,
      );
      await finishAttempt(db, accepted.id, next.attemptId, "runner", result);
      const successfulUsage = await fixture.administrator.query<{
        metrics: ReviewAttemptMetrics;
      }>("select metrics from review_attempts where public_id=$1", [
        next.attemptId,
      ]);
      assert.equal(successfulUsage.rows[0].metrics.finalized, true);
      assert.equal(successfulUsage.rows[0].metrics.estimatedCostUsd, 0.0001);
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
