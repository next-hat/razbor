import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  readdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { agentJobSchema } from "@razbor/contracts";
import {
  applyRegistry,
  registrySchema,
  resolveRepository,
} from "@razbor/database/registry";
import {
  ownedWorkspaces,
  ensureDevelopmentWorkspaces,
  issueToken,
  requestRepositoryDeletion,
  submitReview,
  beginAttempt,
} from "@razbor/database";
import { resultText } from "@razbor/harness/mcp";
import { indexerConfigSchema } from "@razbor/indexer/config";
import { IndexService } from "@razbor/indexer/service";
import { tokenHash } from "@razbor/indexer/tokens";
import { runnerConfigSchema } from "@razbor/runner/config";
import {
  createWorkspace,
  prepareWorkspace,
  removeWorkspace,
} from "@razbor/runner/workspace";

import { databaseFixture } from "@tests/packages/database/fixture.js";
import {
  fixtureUpstream,
  fixtureCommit,
  fixtureGit,
} from "@tests/apps/indexer/fixtures.js";

const executable = process.env.CBM_EXECUTABLE;

/** Poll an asynchronous condition until it succeeds or the cleanup deadline expires. */
async function eventually(check: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("cleanup deadline exceeded");
    await delay(100);
  }
}

test(
  "pull-only service: refresh, revision confinement, tokens and workspace cleanup with actual MCP",
  {
    skip: executable
      ? false
      : "set CBM_EXECUTABLE to the provisioned v0.11.0 portable binary",
    timeout: 240000,
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-index-test-"));
    const upstream = path.join(root, "upstream.git");
    const admin = randomBytes(32).toString("base64url");
    let development = randomBytes(32).toString("base64url");
    const databaseState = await databaseFixture();
    const database = databaseState.database;
    const clients: Client[] = [];
    let service: IndexService | undefined;
    try {
      await fixtureUpstream(upstream);
      const files = {
        "math.ts":
          "export function add(a: number, b: number) { return a + b; }\n",
        "caller.ts":
          'import { add } from "./math";\nexport function total() { return add(1, 2); }\n',
      };
      const first = await fixtureCommit(upstream, files);
      const repo = {
        branch: "master",
        upstream: "refs/remotes/origin/master",
        remotes: { origin: pathToFileURL(upstream).href },
        allow_local: true,
      };
      const config = indexerConfigSchema.parse({
        service: {
          host: "127.0.0.1",
          port: 0,
          data_root: path.join(root, "data"),
          management_token: { env: "UNUSED_FIXTURE_ADMIN" },
        },
        memory: { executable, index_ms: 60000 },
        repositories: { fixture: repo, other: repo },
        tokens: [
          {
            id: "development",
            sha256: tokenHash(development),
            repository: "fixture",
            refresh: true,
          },
        ],
      });
      const registry = registrySchema.parse({
        registry: { key: "index-test" },
        repositories: {
          fixture: {
            git: repo,
            indexing: { owner: "local-indexer", persistent: true },
          },
          other: {
            git: repo,
            indexing: { owner: "local-indexer", persistent: true },
          },
        },
      });
      await applyRegistry(database, registry);
      service = new IndexService(config, admin, database);
      const port = await service.listen();
      const workspaces = await ownedWorkspaces(database, "local-indexer");
      const fixtureId = await resolveRepository(database, "fixture");
      const otherId = await resolveRepository(database, "other");
      const devWorkspace = workspaces.find((w) => w.repositoryId === fixtureId);
      const otherWorkspace = workspaces.find((w) => w.repositoryId === otherId);
      assert.ok(devWorkspace && otherWorkspace);
      const issued = await issueToken(
        database,
        devWorkspace.id,
        "local-indexer",
        { refresh: true },
      );
      development = issued.token;
      /** Persist a fixture review and start its attempt so index operations receive valid ownership IDs. */
      const prepareReview = async (
        baseSha: string,
        headSha: string,
        repositoryId = devWorkspace.repositoryId,
      ) => {
        const review = await submitReview(database, {
          repositoryId,
          baseSha,
          headSha,
        });
        const attempt = await beginAttempt(
          database,
          review.id,
          "fixture",
          180000,
        );
        if (attempt.kind !== "started")
          throw new Error("fixture attempt not started");
        return { attemptId: attempt.attemptId, reviewId: review.id };
      };
      const endpoint = `http://127.0.0.1:${port}`;
      /** Send a JSON request to the isolated indexer with the supplied bearer token and cancellation signal. */
      const request = (
        route: string,
        method: string,
        token: string,
        body?: unknown,
        signal?: AbortSignal,
      ) =>
        fetch(`${endpoint}${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      /** Connect an authenticated MCP client and track it for fixture cleanup. */
      const connect = async (token: string) => {
        const client = new Client({
          name: "razbor-fixture",
          version: "0.1.0",
        });
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
          { timeout: 15000 },
        );
        return client;
      };
      /** Call a fixture MCP tool with a deadline and extract its text result. */
      const query = async (
        client: Client,
        name: string,
        args: Record<string, unknown>,
      ) =>
        resultText(
          await client.callTool({ name, arguments: args }, { timeout: 15000 }),
        );
      assert.equal(
        (
          await request(
            `/workspaces/${devWorkspace.id}/refresh`,
            "POST",
            "invalid",
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await request(
            `/workspaces/${otherWorkspace.id}/refresh`,
            "POST",
            development,
          )
        ).status,
        403,
      );
      const initial = await request(
        `/workspaces/${devWorkspace.id}/refresh`,
        "POST",
        development,
      );
      assert.equal(initial.status, 200, await initial.clone().text());
      assert.equal((await initial.json()).headSha, first);
      const devClient = await connect(development);
      const tools = (await devClient.listTools()).tools.map(
        (tool) => tool.name,
      );
      assert.ok(tools.includes("search_graph"));
      assert.ok(!tools.includes("index_repository"));
      assert.equal(
        (
          await devClient.callTool({
            name: "search_graph",
            arguments: { project: "other", name_pattern: "add" },
          })
        ).isError,
        true,
      );
      assert.equal(
        (await devClient.callTool({ name: "delete_project", arguments: {} }))
          .isError,
        true,
      );
      assert.match(
        await query(devClient, "search_graph", { name_pattern: "^add$" }),
        /add/,
      );
      const reviewHead = await fixtureCommit(
        upstream,
        {
          ...files,
          "math.ts":
            "export function add(a: number, b: number) { return a - b; }\n",
        },
        first,
        "refs/heads/feature",
      );
      const firstAttempt = await prepareReview(first, reviewHead);
      const attempt = firstAttempt.attemptId;
      const review = await request("/reviews", "POST", admin, {
        repositoryId: devWorkspace.repositoryId,
        baseSha: first,
        headSha: reviewHead,
        attemptId: attempt,
        reviewId: firstAttempt.reviewId,
        ttlMs: 120000,
      });
      assert.equal(review.status, 201, await review.clone().text());
      const lease = await review.json();
      assert.equal(lease.headSha, reviewHead);
      assert.equal(lease.indexHeadSha, first);
      assert.equal(lease.project, devWorkspace.id);
      const reviewClient = await connect(lease.token);
      assert.equal(
        (
          await request(
            `/workspaces/${devWorkspace.id}/refresh`,
            "POST",
            lease.token,
          )
        ).status,
        403,
      );
      assert.equal(
        (await request(`/reviews/${attempt}`, "DELETE", lease.token)).status,
        403,
      );
      files["math.ts"] += "export function afterRefresh() { return 42; }\n";
      const second = await fixtureCommit(upstream, files, first);
      // A remote change alone changes neither the development checkout nor an active review.
      assert.equal(
        JSON.parse(await query(devClient, "index_status", { format: "json" }))
          .headSha,
        first,
      );
      const refreshing = request(
        `/workspaces/${devWorkspace.id}/refresh`,
        "POST",
        development,
      );
      await delay(50);
      const duringRefresh = devClient.callTool(
        { name: "index_status", arguments: { format: "json" } },
        { timeout: 90000 },
      );
      const [firstRefresh, status] = await Promise.all([
        refreshing,
        duringRefresh,
      ]);
      let refreshed = firstRefresh;
      if (firstRefresh.status === 503) {
        // The pinned v0.11.0 watcher can miss an early checkout update. The
        // documented explicit retry must recover at the new revision without
        // serving the old generation during the failed refresh.
        assert.equal(status.isError, true);
        refreshed = await request(
          `/workspaces/${devWorkspace.id}/refresh`,
          "POST",
          development,
        );
      } else {
        assert.equal(JSON.parse(resultText(status)).headSha, second);
      }
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
      assert.equal((await refreshed.json()).headSha, second);
      assert.match(
        await query(devClient, "search_graph", {
          name_pattern: "^afterRefresh$",
        }),
        /afterRefresh/,
      );
      assert.equal(
        JSON.parse(await query(devClient, "index_status", { format: "json" }))
          .headSha,
        second,
      );
      // A review cannot silently switch to a newer shared graph generation.
      assert.equal(
        (
          await reviewClient.callTool({
            name: "index_status",
            arguments: { format: "json" },
          })
        ).isError,
        true,
      );
      await assert.rejects(
        access(path.join(root, "data/reviews", lease.workspaceId, "state")),
      );
      assert.equal(
        await readFile(
          path.join(
            root,
            "data/reviews",
            lease.workspaceId,
            "repository/math.ts",
          ),
          "utf8",
        ),
        "export function add(a: number, b: number) { return a - b; }\n",
      );
      // Local edits are preserved and make the index unavailable, never stashed/reset.
      const localFile = path.join(
        root,
        `data/development/${devWorkspace.id}/repository/math.ts`,
      );
      await writeFile(localFile, "local change\n");
      const dirty = await request(
        `/workspaces/${devWorkspace.id}/refresh`,
        "POST",
        development,
      );
      assert.equal(dirty.status, 503);
      assert.match(await dirty.text(), /local changes/);
      assert.equal(await readFile(localFile, "utf8"), "local change\n");
      assert.equal(
        (
          await devClient.callTool({
            name: "search_graph",
            arguments: { name_pattern: "add" },
          })
        ).isError,
        true,
      );
      await writeFile(localFile, files["math.ts"]);
      await fixtureCommit(
        path.join(root, `data/development/${devWorkspace.id}/repository`),
        files,
        second,
      );
      // Divergent service-owned history is discarded through a fresh clone.
      const divergent = await request(
        `/workspaces/${devWorkspace.id}/refresh`,
        "POST",
        development,
      );
      assert.equal(divergent.status, 200, await divergent.clone().text());
      assert.equal((await divergent.json()).headSha, second);
      assert.equal(
        (await request(`/reviews/${attempt}`, "DELETE", admin)).status,
        200,
      );
      assert.equal(
        (await request("/mcp", "POST", lease.token, {})).status,
        401,
      );
      await assert.rejects(
        access(path.join(root, "data/reviews", lease.workspaceId)),
      );
      const expiringAttempt = await prepareReview(first, second);
      const expiringId = expiringAttempt.attemptId;
      const expiring = await request("/reviews", "POST", admin, {
        repositoryId: devWorkspace.repositoryId,
        baseSha: first,
        headSha: second,
        attemptId: expiringId,
        reviewId: expiringAttempt.reviewId,
        ttlMs: 1000,
      });
      assert.equal(expiring.status, 201);
      const shortLease = await expiring.json();
      await eventually(
        async () =>
          (await request("/mcp", "POST", shortLease.token, {})).status === 401,
        5000,
      );
      await eventually(async () =>
        access(path.join(root, "data/reviews", shortLease.workspaceId)).then(
          () => false,
          () => true,
        ),
      );
      // Use the cold shared workspace so cancellation interrupts real preparation.
      const cancelledAttempt = await prepareReview(
        first,
        second,
        otherWorkspace.repositoryId,
      );
      const cancelledId = cancelledAttempt.attemptId;
      await assert.rejects(
        request(
          "/reviews",
          "POST",
          admin,
          {
            repositoryId: otherWorkspace.repositoryId,
            baseSha: first,
            headSha: second,
            attemptId: cancelledId,
            reviewId: cancelledAttempt.reviewId,
            ttlMs: 10000,
          },
          AbortSignal.timeout(500),
        ),
      );
      await eventually(
        async () =>
          !(await ownedWorkspaces(database, "local-indexer")).some(
            (w) => w.attemptId === cancelledId,
          ),
      );
      // A review admitted before disabling can still use its index. Its
      // exception cannot grant a development token or management refresh.
      const pinnedAttempt = await prepareReview(first, second);
      registry.repositories.fixture.codebaseMemoryEnabled = false;
      await applyRegistry(database, registry);
      const prepared = await request("/reviews", "POST", admin, {
        repositoryId: devWorkspace.repositoryId,
        baseSha: first,
        headSha: second,
        ...pinnedAttempt,
        ttlMs: 60000,
      });
      assert.equal(prepared.status, 201, await prepared.clone().text());
      const pinned = await prepared.json();
      assert.equal(pinned.indexHeadSha, second);
      const pinnedClient = await connect(pinned.token);
      assert.ok(
        (await pinnedClient.listTools()).tools.some(
          (tool) => tool.name === "search_graph",
        ),
      );
      assert.equal(
        (await request("/mcp", "POST", development, {})).status,
        401,
      );
      assert.equal(
        (await request(`/workspaces/${devWorkspace.id}/refresh`, "POST", admin))
          .status,
        503,
      );
      assert.equal(
        (
          await request(
            `/repositories/${devWorkspace.repositoryId}/index`,
            "POST",
            admin,
            { prepare: true },
          )
        ).status,
        503,
      );
      assert.equal(
        (await request(`/reviews/${pinnedAttempt.attemptId}`, "DELETE", admin))
          .status,
        200,
      );
      assert.equal(
        (await request(`/tokens/${issued.id}`, "DELETE", admin)).status,
        200,
      );
      assert.equal(
        (await request("/mcp", "POST", development, {})).status,
        401,
      );
      await assert.rejects(devClient.listTools());
      await service.close();
      service = new IndexService(config, admin, database);
      const restarted = await service.listen();
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${restarted}/mcp`, {
            method: "POST",
            headers: { Authorization: `Bearer ${development}` },
          })
        ).status,
        401,
      );
      // A source-only deployment can retire an existing, cleanly stopped graph checkout.
      await service.close();
      await requestRepositoryDeletion(database, devWorkspace.repositoryId, {
        confirmation: "fixture",
      });
      service = new IndexService(
        { ...config, memory: undefined },
        admin,
        database,
      );
      await service.listen();
      assert.ok(
        !(await ownedWorkspaces(database, "local-indexer")).some(
          (w) => w.id === devWorkspace.id,
        ),
      );
      await assert.rejects(access(devWorkspace.root), { code: "ENOENT" });
      console.log(
        "Verified real MCP refresh, shared index revision pinning, separate PR checkout, scoped tokens, durable revocation, expiry and cancellation cleanup.",
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      try {
        await service?.close();
      } finally {
        await databaseState.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "source-only attempts hand off exact Git objects and expire without indexing infrastructure",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-source-test-"));
    const state = await databaseFixture();
    let service: IndexService | undefined;
    try {
      const upstream = path.join(root, "upstream.git");
      await fixtureUpstream(upstream);
      const baseSha = await fixtureCommit(upstream, {
        "base.txt": "base\n",
        "common.txt": "unchanged\n",
        "AGENTS.md": "Base instructions\n",
      });
      const headSha = await fixtureCommit(
        upstream,
        {
          "head.txt": "head\n",
          "common.txt": "unchanged\n",
          "AGENTS.md": "Changed instructions\n",
        },
        baseSha,
        "refs/heads/feature",
      );
      const registry = registrySchema.parse({
        registry: { key: "source-test" },
        repositories: {
          fixture: {
            codebaseMemoryEnabled: false,
            git: {
              branch: "master",
              upstream: "refs/remotes/origin/master",
              remotes: { origin: pathToFileURL(upstream).href },
              allow_local: true,
            },
            indexing: { owner: "local-indexer", persistent: true },
          },
        },
      });
      await applyRegistry(state.database, registry);
      const repositoryId = await resolveRepository(state.database, "fixture");
      assert.ok(repositoryId);
      const repo = { repositoryId, baseSha, headSha };
      const admin = randomBytes(32).toString("base64url");
      const config = indexerConfigSchema.parse({
        service: {
          host: "127.0.0.1",
          port: 0,
          data_root: path.join(root, "source"),
          management_token: { env: "UNUSED_FIXTURE_ADMIN" },
        },
      });
      service = new IndexService(config, admin, state.database);
      let port = await service.listen();

      /** Send an authenticated request to the loopback fixture service. */
      const request = (
        route: string,
        method: string,
        token: string,
        payload?: unknown,
      ) =>
        fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });

      /** Reserve a real database attempt before its repository setting changes. */
      const reserve = async () => {
        const review = await submitReview(state.database, repo);
        const attempt = await beginAttempt(
          state.database,
          review.id,
          "fixture",
          60000,
        );
        assert.equal(attempt.kind, "started");
        return { ...repo, reviewId: review.id, attemptId: attempt.attemptId };
      };
      const first = await reserve();
      const other = await reserve();
      registry.repositories.fixture.codebaseMemoryEnabled = true;
      await applyRegistry(state.database, registry);
      assert.equal(
        (
          await request("/reviews", "POST", admin, {
            ...first,
            headSha: baseSha,
            ttlMs: 30000,
          })
        ).status,
        503,
      );
      const response = await request("/reviews", "POST", admin, {
        ...first,
        ttlMs: 30000,
      });
      assert.equal(response.status, 201, await response.clone().text());
      const lease = await response.json();
      assert.equal(lease.headSha, headSha);
      for (const key of ["project", "indexHeadSha", "indexBranch"])
        assert.ok(!(key in lease));
      assert.equal(
        (await request("/mcp", "POST", lease.token, {})).status,
        403,
      );
      assert.equal(
        (
          await request(
            `/reviews/${other.attemptId}/source`,
            "GET",
            lease.token,
          )
        ).status,
        403,
      );
      assert.equal(
        (await request(`/reviews/${first.attemptId}/source`, "GET", "invalid"))
          .status,
        401,
      );
      await assert.rejects(access(path.join(root, "source/development")), {
        code: "ENOENT",
      });
      assert.deepEqual(
        (await ownedWorkspaces(state.database, "local-indexer")).map(
          (w) => w.attemptId,
        ),
        [first.attemptId],
      );

      const runnerRoot = path.join(root, "runner");
      const runner = {
        ...runnerConfigSchema.parse({
          storage: { root: runnerRoot, runtime_root: process.cwd() },
          capabilities: { base_instructions: true },
        }),
        hostRoot: runnerRoot,
        dependenciesVolume: "fixture",
        network: "fixture",
      };
      const checkout = await createWorkspace(runner, first.attemptId);
      await prepareWorkspace(
        runner,
        checkout,
        {
          version: 1,
          reviewId: first.reviewId,
          ...repo,
          submittedAt: new Date().toISOString(),
        },
        AbortSignal.timeout(10000),
        {
          url: `http://127.0.0.1:${port}/reviews/${first.attemptId}/source`,
          token: lease.token,
        },
      );
      assert.equal(
        await fixtureGit(checkout.repository, ["rev-parse", "HEAD"]),
        headSha,
      );
      assert.equal(
        await fixtureGit(checkout.repository, ["show", `${baseSha}:base.txt`]),
        "base",
      );
      assert.equal(
        await readFile(path.join(checkout.repository, "common.txt"), "utf8"),
        "unchanged\n",
      );
      assert.equal(
        await readFile(path.join(checkout.repository, "head.txt"), "utf8"),
        "head\n",
      );
      assert.equal(await fixtureGit(checkout.repository, ["remote"]), "");
      const input = agentJobSchema.parse(
        JSON.parse(
          await readFile(path.join(checkout.root, "input/job.json"), "utf8"),
        ),
      );
      assert.equal(input.baseline, baseSha);
      assert.equal(input.capabilities?.codebaseMemory, undefined);
      assert.equal(
        input.capabilities?.instructions[0]?.provenance,
        `${baseSha}:AGENTS.md`,
      );
      await removeWorkspace(runner, checkout);
      assert.equal(
        (await request(`/reviews/${first.attemptId}`, "DELETE", admin)).status,
        200,
      );
      assert.equal(
        (
          await request(
            `/reviews/${first.attemptId}/source`,
            "GET",
            lease.token,
          )
        ).status,
        401,
      );
      await assert.rejects(
        access(
          path.join(config.service.data_root, "reviews", lease.workspaceId),
        ),
        { code: "ENOENT" },
      );

      // Also cover a mixed deployment whose configured optional components are unavailable.
      registry.repositories.fixture.codebaseMemoryEnabled = false;
      for (const key of ["stale", "misplaced", "linked"])
        registry.repositories[key] = {
          ...registry.repositories.fixture,
          codebaseMemoryEnabled: true,
        };
      await applyRegistry(state.database, registry);
      await service.close();
      await ensureDevelopmentWorkspaces(
        state.database,
        config.service.owner,
        config.service.data_root,
      );
      const stored = await ownedWorkspaces(
        state.database,
        config.service.owner,
      );
      const staleId = await resolveRepository(state.database, "stale");
      const misplacedId = await resolveRepository(state.database, "misplaced");
      const linkedId = await resolveRepository(state.database, "linked");
      assert.ok(staleId && misplacedId && linkedId);
      const misplaced = stored.find((w) => w.repositoryId === misplacedId);
      const linked = stored.find((w) => w.repositoryId === linkedId);
      assert.ok(misplaced && linked);
      // Preserve evidence under both kinds of invalid storage. The reaper
      // must refuse those deletions while expiring an unrelated source lease.
      const outside = path.join(root, "unrelated");
      for (const workspace of [misplaced, linked]) {
        const directory = path.join(outside, workspace.id);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "keep"), "owned elsewhere");
      }
      await symlink(
        outside,
        path.join(config.service.data_root, "development"),
      );
      await state.administrator.query(
        "UPDATE index_workspaces SET root=$2 WHERE public_id=$1",
        [misplaced.id, path.join(outside, misplaced.id)],
      );
      registry.repositories.stale.git = {
        ...registry.repositories.stale.git,
        branch: "new-branch",
      };
      await applyRegistry(state.database, registry);
      await requestRepositoryDeletion(state.database, misplacedId, {
        confirmation: "misplaced",
      });
      service = new IndexService(
        indexerConfigSchema.parse({
          ...config,
          memory: { executable: path.join(root, "missing-binary") },
          embeddings: {
            endpoint: "http://127.0.0.1:1",
            token: { file: path.join(root, "missing-secret") },
          },
        }),
        admin,
        state.database,
      );
      port = await service.listen();
      for (const id of [staleId, linkedId])
        assert.equal(
          (
            await request(`/repositories/${id}/index`, "POST", admin, {
              prepare: false,
            })
          ).status,
          503,
        );
      await requestRepositoryDeletion(state.database, linkedId, {
        confirmation: "linked",
      });
      const expiring = await request("/reviews", "POST", admin, {
        ...other,
        ttlMs: 1000,
      });
      assert.equal(expiring.status, 201, await expiring.clone().text());
      const short = await expiring.json();
      assert.equal(
        (await request("/mcp", "POST", short.token, {})).status,
        403,
      );
      await eventually(
        async () =>
          !(await ownedWorkspaces(state.database, "local-indexer")).some(
            (w) => w.temporary,
          ),
        10000,
      );
      assert.equal(
        (
          await request(
            `/reviews/${other.attemptId}/source`,
            "GET",
            short.token,
          )
        ).status,
        401,
      );
      assert.deepEqual(
        await readdir(path.join(config.service.data_root, "reviews")),
        [],
      );
      for (const workspace of [misplaced, linked])
        assert.equal(
          await readFile(path.join(outside, workspace.id, "keep"), "utf8"),
          "owned elsewhere",
        );
    } finally {
      try {
        await service?.close();
      } finally {
        await state.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
