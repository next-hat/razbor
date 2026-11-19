import assert from "node:assert/strict";
import childProcess, {
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  readdir,
  symlink,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import {
  agentJobSchema,
  codebaseMemoryUnavailableCode,
  codebaseMemoryUnavailableMessage,
} from "@razbor/contracts";
import {
  applyRegistry,
  registrySchema,
  resolveRepository,
} from "@razbor/database/registry";
import {
  ownedWorkspaces,
  ensureDevelopmentWorkspaces,
  issueToken,
  revokeToken,
  getRepository,
  repositoryIndexSetup,
  requestRepositoryDeletion,
  submitReview,
  beginAttempt,
} from "@razbor/database";
import { resultText } from "@razbor/harness/mcp";
import { logger } from "@razbor/harness/logger";
import { indexerConfigSchema } from "@razbor/indexer/config";
import { IndexService } from "@razbor/indexer/service";
import { Tokens, tokenHash } from "@razbor/indexer/tokens";
import { runnerConfigSchema } from "@razbor/runner/config";
import {
  createWorkspace,
  prepareWorkspace,
  removeWorkspace,
} from "@razbor/runner/workspace";

import { databaseFixture } from "@tests/packages/database/fixture.js";
import {
  eventually,
  fixtureUpstream,
  fixtureCommit,
  fixtureGit,
} from "@tests/apps/indexer/fixtures.js";

const executable = process.env.CBM_EXECUTABLE;

test(
  "pull-only service: refresh, revision confinement, tokens and workspace cleanup with actual MCP",
  {
    skip: executable
      ? false
      : "set CBM_EXECUTABLE to the provisioned v0.11.0 portable binary",
    timeout: 300000,
  },
  async (t) => {
    assert.ok(
      executable && path.isAbsolute(executable),
      "CBM_EXECUTABLE must be an absolute path",
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-index-test-"));
    const upstream = path.join(root, "upstream.git");
    const admin = randomBytes(32).toString("base64url");
    let development = randomBytes(32).toString("base64url");
    const databaseState = await databaseFixture();
    const database = databaseState.database;
    const clients: Client[] = [];
    let service: IndexService | undefined;
    try {
      const bundleDirectory = path.join(root, "bundle");
      const bundle = path.join(bundleDirectory, path.basename(executable));
      await symlink(path.dirname(executable), bundleDirectory);
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
        memory: { executable: bundle, index_ms: 60000 },
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
          recovery: {
            git: repo,
            indexing: { owner: "local-indexer", persistent: true },
          },
          cleanup: {
            git: repo,
            indexing: { owner: "local-indexer", persistent: true },
          },
          launch: {
            git: repo,
            indexing: { owner: "local-indexer", persistent: true },
          },
          onDemand: {
            git: repo,
            indexing: { owner: "local-indexer", persistent: false },
          },
        },
      });
      await applyRegistry(database, registry);
      const read = fs.createReadStream;
      let failedReads = 0;
      let deniedAt: number | undefined;
      let readError = "EIO";
      const unavailable = t.mock.method(
        fs,
        "createReadStream",
        (...[file, options]: Parameters<typeof read>) => {
          if (file === bundle) {
            failedReads++;
            if (readError === "EACCES") deniedAt = performance.now();
            throw Object.assign(new Error("fixture bundle read interrupted"), {
              code: readError,
            });
          }
          return read(file, options);
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        unavailable.mock.restore();
        syncBuiltinESMExports();
      });
      service = new IndexService(config, admin, database);
      const port = await service.listen();
      const workspaces = await ownedWorkspaces(database, "local-indexer");
      const fixtureId = await resolveRepository(database, "fixture");
      const otherId = await resolveRepository(database, "other");
      const recoveryId = await resolveRepository(database, "recovery");
      const devWorkspace = workspaces.find((w) => w.repositoryId === fixtureId);
      const otherWorkspace = workspaces.find((w) => w.repositoryId === otherId);
      assert.ok(devWorkspace && otherWorkspace && recoveryId);
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
      await Promise.all(
        [1, 2, 3].map(async () => {
          assert.deepEqual(
            await (await request("/health", "GET", admin)).json(),
            {
              status: "ready",
            },
          );
        }),
      );
      assert.equal(failedReads, 1);
      await repositoryIndexSetup(
        database,
        "local-indexer",
        recoveryId,
        "pending",
      );
      const interrupted = await prepareReview(first, first, recoveryId);
      const retryable = await request("/reviews", "POST", admin, {
        ...interrupted,
        repositoryId: recoveryId,
        baseSha: first,
        headSha: first,
        ttlMs: 30000,
      });
      assert.equal(retryable.status, 503);
      assert.equal(retryable.headers.get("x-razbor-error-code"), null);
      assert.match((await retryable.json()).error, /temporarily unavailable/);
      // A maintenance probe has retried the unreadable bundle. Keep the pending setup eligible.
      await eventually(async () => failedReads >= 2);
      assert.equal(
        (await getRepository(database, recoveryId))?.setupState,
        "pending",
      );
      await t.test(
        "a cached read denial leaves graph capability unknown after access is repaired",
        async (t) => {
          // The reaper observes the fresh denial first. Freeze its cooldown at that instant
          // so subsequent requests exercise the cached result regardless of HTTP scheduling.
          const clock = performance.now.bind(performance);
          t.mock.method(performance, "now", () => deniedAt ?? clock());
          readError = "EACCES";
          await eventually(
            async () =>
              (await getRepository(database, recoveryId))?.setupError ===
              codebaseMemoryUnavailableMessage,
          );
          unavailable.mock.restore();
          syncBuiltinESMExports();
          assert.deepEqual(
            await (await request("/health", "GET", admin)).json(),
            { status: "ready" },
          );
          const cached = await request(
            `/repositories/${recoveryId}/index`,
            "POST",
            admin,
            { prepare: false },
          );
          assert.equal(cached.status, 503);
          assert.equal(cached.headers.get("x-razbor-error-code"), null);
          assert.match((await cached.json()).error, /temporarily unavailable/);
        },
      );
      await unlink(bundleDirectory);
      await repositoryIndexSetup(
        database,
        "local-indexer",
        recoveryId,
        "pending",
      );
      assert.deepEqual(await (await request("/health", "GET", admin)).json(), {
        status: "ready",
        capabilities: { codebaseMemory: false },
      });
      await eventually(
        async () =>
          (await getRepository(database, recoveryId))?.setupError ===
          codebaseMemoryUnavailableMessage,
      );
      // Restore the same executable after a confirmed missing-bundle outage.
      await symlink(path.dirname(executable), bundleDirectory);
      await eventually(
        async (signal) =>
          (
            await (
              await request("/health", "GET", admin, undefined, signal)
            ).json()
          ).capabilities?.codebaseMemory === true,
      );
      await eventually(
        async () =>
          (await getRepository(database, recoveryId))?.setupState === "ready",
        90000,
      );
      await t.test(
        "effective execute permission and an interrupted on-demand preparation",
        async (t) => {
          const onDemandId = await resolveRepository(database, "onDemand");
          assert.ok(onDemandId);
          const checkAccess = fs.promises.access;
          let denyExecute = true;
          const permissions = t.mock.method(
            fs.promises,
            "access",
            async (...args: Parameters<typeof checkAccess>) => {
              if (args[0] === bundle && args[1] === fs.constants.X_OK) {
                if (denyExecute)
                  throw Object.assign(new Error("fixture execute denied"), {
                    code: "EPERM",
                  });
                // Interrupt the in-flight check after the first admission has provisioned the workspace.
                if (
                  (await getRepository(database, onDemandId))?.setupState ===
                  "indexing"
                )
                  throw Object.assign(new Error("fixture access interrupted"), {
                    code: "EMFILE",
                  });
              }
              return checkAccess(...args);
            },
          );
          syncBuiltinESMExports();
          t.after(() => {
            permissions.mock.restore();
            syncBuiltinESMExports();
          });
          /** Request the on-demand graph through its management entry point. */
          const provision = () =>
            request(`/repositories/${onDemandId}/index`, "POST", admin, {
              prepare: true,
            });
          const denied = await provision();
          assert.equal(denied.status, 503);
          assert.equal(
            denied.headers.get("x-razbor-error-code"),
            codebaseMemoryUnavailableCode,
          );
          await denied.body?.cancel();
          denyExecute = false;
          const interrupted = await provision();
          assert.equal(interrupted.status, 503);
          assert.equal(interrupted.headers.get("x-razbor-error-code"), null);
          assert.match(
            (await interrupted.json()).error,
            /temporarily unavailable/,
          );
          assert.equal(
            (await getRepository(database, onDemandId))?.setupState,
            "ready",
          );
        },
      );
      await t.test(
        "a restored bundle retries while a checkout restored after a failed spawn stays failed",
        async (t) => {
          const launchId = await resolveRepository(database, "launch");
          const launch = workspaces.find((w) => w.repositoryId === launchId);
          assert.ok(launch);
          const onDemandId = await resolveRepository(database, "onDemand");
          assert.ok(onDemandId);
          await ensureDevelopmentWorkspaces(
            database,
            "local-indexer",
            config.service.data_root,
            onDemandId,
          );
          const onDemand = (
            await ownedWorkspaces(database, "local-indexer")
          ).find((w) => w.repositoryId === onDemandId);
          assert.ok(onDemand);
          const checkout = path.join(onDemand.root, "repository");
          const parked = path.join(onDemand.root, "parked");
          let moved = false;
          let checkoutRestored = false;
          let hidden = false;
          let restored = false;
          const children = channel("child_process");
          /** Restore the checkout on the child's real ENOENT, before cleanup and the capability recheck. */
          function observeSpawn(message: unknown) {
            if (!moved || checkoutRestored) return;
            (message as { process: ChildProcess }).process.once(
              "error",
              (error: NodeJS.ErrnoException) => {
                if (
                  error.code === "ENOENT" &&
                  error.path === bundle &&
                  error.syscall === `spawn ${bundle}`
                ) {
                  fs.renameSync(parked, checkout);
                  checkoutRestored = true;
                }
              },
            );
          }
          children.subscribe(observeSpawn);
          // The workspace reports the originating failure before daemon cleanup.
          // Restore the bundle then, so the service's later probe sees it healthy.
          const warn = logger.warn;
          t.mock.method(logger, "warn", (...args: unknown[]) => {
            const [fields, message] = args;
            if (
              hidden &&
              !restored &&
              message === "workspace index preparation failed" &&
              (fields as { workspaceId?: string })?.workspaceId === launch.id
            ) {
              fs.symlinkSync(path.dirname(executable!), bundleDirectory);
              restored = true;
            }
            return Reflect.apply(warn, logger, args);
          });
          const write = fs.promises.writeFile;
          const interrupt = t.mock.method(
            fs.promises,
            "writeFile",
            async (...args: Parameters<typeof write>) => {
              await write(...args);
              // Writing the CBM configuration immediately precedes its version command.
              if (
                !moved &&
                args[0] === path.join(onDemand.root, "state/cache/config.json")
              ) {
                await fs.promises.rename(checkout, parked);
                moved = true;
              }
              if (
                !hidden &&
                args[0] === path.join(launch.root, "state/cache/config.json")
              ) {
                await unlink(bundleDirectory);
                hidden = true;
              }
            },
          );
          syncBuiltinESMExports();
          t.after(async () => {
            interrupt.mock.restore();
            syncBuiltinESMExports();
            children.unsubscribe(observeSpawn);
            if (moved && !checkoutRestored)
              await fs.promises.rename(parked, checkout);
            if (hidden && !restored)
              await symlink(path.dirname(executable!), bundleDirectory);
          });
          /** Request preparation once; the persistent workspace's recovery must come from the reaper. */
          const prepare = (repository: string) =>
            request(`/repositories/${repository}/index`, "POST", admin, {
              prepare: true,
            });
          const missingCheckout = await prepare(onDemand.repositoryId);
          assert.equal(missingCheckout.status, 503);
          assert.match(
            (await missingCheckout.json()).error,
            /index operation failed/,
          );
          assert.ok(checkoutRestored);
          assert.equal(
            (await getRepository(database, onDemand.repositoryId))?.setupState,
            "error",
          );
          const lost = await prepare(launch.repositoryId);
          assert.equal(lost.status, 503);
          assert.equal(lost.headers.get("x-razbor-error-code"), null);
          assert.match((await lost.json()).error, /temporarily unavailable/);
          assert.ok(restored);
          await eventually(
            async () =>
              (await getRepository(database, launch.repositoryId))
                ?.setupState === "ready",
            90000,
          );
          assert.equal(
            (await ownedWorkspaces(database, "local-indexer", launch.id))[0]
              ?.headSha,
            first,
          );
          assert.equal(
            (await getRepository(database, onDemand.repositoryId))?.setupState,
            "error",
          );
        },
      );
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
      // Keep the client connected while an operator changes the registered branch.
      // A cached graph cannot serve its previous policy even before the next refresh.
      registry.repositories.fixture.git.branch = "next-branch";
      await applyRegistry(database, registry);
      await assert.rejects(devClient.listTools());
      assert.equal(
        (await devClient.callTool({ name: "index_status", arguments: {} }))
          .isError,
        true,
      );
      registry.repositories.fixture.git.branch = repo.branch;
      await applyRegistry(database, registry);
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
      // Preparation owns the workspace queue before it publishes unready. A
      // fast refresh may already have published the new head when we observe it.
      const duringRefresh = eventually(async () => {
        const [workspace] = await ownedWorkspaces(
          database,
          config.service.owner,
          devWorkspace.id,
        );
        return workspace?.state === "unready" || workspace?.headSha === second;
      }).then(() =>
        devClient.callTool(
          { name: "index_status", arguments: { format: "json" } },
          { timeout: 90000 },
        ),
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
        async (signal) =>
          (await request("/mcp", "POST", shortLease.token, {}, signal))
            .status === 401,
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
      // Hold the first durable retirement update until the repository has been
      // re-enabled, then fail it. The subsequent retry must close the old
      // handle before preparing a replacement for these same files.
      const sqlClient = databaseState.administrator;
      await sqlClient.query(`
        create sequence fixture_retirement_calls;
        create function fixture_interrupt_retirement() returns trigger
          language plpgsql security definer set search_path = pg_catalog, public as $$
        begin
          if nextval('public.fixture_retirement_calls') = 1 then
            perform pg_advisory_xact_lock(419272, 1);
            raise exception 'fixture: interrupted retirement write';
          end if;
          return new;
        end;
        $$;
        create trigger fixture_retirement before update on index_workspaces
        for each row when (old.public_id = '${devWorkspace.id}' and new.state = 'unready')
        execute function fixture_interrupt_retirement();
        select pg_advisory_lock(419272, 1);
      `);
      try {
        assert.equal(
          (
            await request(
              `/reviews/${pinnedAttempt.attemptId}`,
              "DELETE",
              admin,
            )
          ).status,
          200,
        );
        await eventually(
          async () =>
            (
              await sqlClient.query(
                "select is_called from fixture_retirement_calls",
              )
            ).rows[0].is_called,
        );
        registry.repositories.fixture.codebaseMemoryEnabled = true;
        await applyRegistry(database, registry);
      } finally {
        await sqlClient.query("select pg_advisory_unlock(419272, 1)");
      }
      await eventually(async (signal) => {
        const retry = await request(
          `/repositories/${devWorkspace.repositoryId}/index`,
          "POST",
          admin,
          { prepare: true },
          signal,
        );
        const binding = await retry.json();
        return (
          retry.ok &&
          binding.workspaceId === devWorkspace.id &&
          binding.headSha === second
        );
      }, 60000);
      await t.test(
        "restoring the bundle retries unconfirmed daemon cleanup before starting a fresh graph",
        async (t) => {
          const repositoryId = await resolveRepository(database, "cleanup");
          const workspace = workspaces.find(
            (item) => item.repositoryId === repositoryId,
          );
          assert.ok(workspace);
          const state = path.join(workspace.root, "state");
          const runtime =
            "/tmp/rdm-" +
            createHash("sha256").update(state).digest("hex").slice(0, 20);
          const marker = path.join(runtime, "retained-by-fixture");
          const write = fs.promises.writeFile;
          let launches = 0;
          let hidden = false;
          const interrupt = t.mock.method(
            fs.promises,
            "writeFile",
            async (...args: Parameters<typeof write>) => {
              await write(...args);
              if (args[0] !== path.join(state, "cache/config.json")) return;
              if (++launches === 1) {
                await write(marker, "retain until shutdown is confirmed");
                await unlink(bundleDirectory);
                hidden = true;
              } else {
                await assert.rejects(access(marker), { code: "ENOENT" });
              }
            },
          );
          syncBuiltinESMExports();
          try {
            const initial = await request(
              `/repositories/${workspace.repositoryId}/index`,
              "POST",
              admin,
              { prepare: true },
            );
            assert.equal(initial.status, 503);
            assert.equal(
              initial.headers.get("x-razbor-error-code"),
              codebaseMemoryUnavailableCode,
            );
            await initial.body?.cancel();
            assert.equal(
              (await getRepository(database, workspace.repositoryId))
                ?.setupError,
              codebaseMemoryUnavailableMessage,
            );
            assert.equal(
              await readFile(marker, "utf8"),
              "retain until shutdown is confirmed",
            );
            await symlink(path.dirname(executable), bundleDirectory);
            hidden = false;
            // Only the reaper can retry this initial request after the bundle returns.
            await eventually(async () => {
              const repository = await getRepository(
                database,
                workspace.repositoryId,
              );
              if (repository?.setupState === "error")
                assert.equal(
                  repository.setupError,
                  codebaseMemoryUnavailableMessage,
                );
              return repository?.setupState === "ready";
            }, 90000);
            assert.equal(launches, 2);
            assert.equal(
              (
                await ownedWorkspaces(database, "local-indexer", workspace.id)
              )[0]?.headSha,
              second,
            );
          } finally {
            interrupt.mock.restore();
            syncBuiltinESMExports();
            if (hidden)
              await symlink(path.dirname(executable), bundleDirectory);
          }
        },
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
  async (t) => {
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
          sync_ms: 45000,
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
        signal?: AbortSignal,
      ) =>
        fetch(`http://127.0.0.1:${port}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal,
        });

      assert.equal((await request("/health", "GET", "invalid")).status, 401);
      assert.deepEqual(await (await request("/health", "GET", admin)).json(), {
        status: "ready",
        capabilities: { codebaseMemory: false },
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
      await eventually(
        async () =>
          (await getRepository(state.database, repositoryId))?.setupError ===
          codebaseMemoryUnavailableMessage,
      );
      const required = await reserve();
      const incompatible = await request("/reviews", "POST", admin, {
        ...required,
        ttlMs: 30000,
      });
      assert.equal(incompatible.status, 503);
      assert.equal(
        incompatible.headers.get("x-razbor-error-code"),
        codebaseMemoryUnavailableCode,
      );
      assert.deepEqual(await incompatible.json(), {
        error: codebaseMemoryUnavailableMessage,
      });
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
      await t.test(
        "queued handoff checks durable token revocation at the start of transfer",
        async (t) => {
          const secondGrant = await issueToken(
            state.database,
            lease.workspaceId,
            config.service.owner,
            { refresh: false },
          );
          const gate = new EventEmitter();
          const releaseFirst = once(gate, "release");
          const downloads: Promise<Response>[] = [];
          const controller = new AbortController();
          const signal = AbortSignal.any([
            controller.signal,
            t.signal,
            AbortSignal.timeout(10000),
          ]);
          const authorize = Tokens.prototype.authorize;
          const authorizeWorkspace = Tokens.prototype.authorizeWorkspace;
          let transfers = 0;
          // Isolate the dispatch check from the independent background cancellation poll.
          t.mock.method(Tokens.prototype, "poll", async () => {});
          t.mock.method(
            Tokens.prototype,
            "authorize",
            async function (this: Tokens, token: string) {
              const grant = await authorize.call(this, token);
              if (token === secondGrant.token) gate.emit("admitted");
              return grant;
            },
          );
          t.mock.method(
            Tokens.prototype,
            "authorizeWorkspace",
            async function (
              this: Tokens,
              ...args: Parameters<typeof authorizeWorkspace>
            ) {
              transfers++;
              if (args[0] === lease.token) {
                gate.emit("transfer");
                await releaseFirst;
              }
              return authorizeWorkspace.call(this, ...args);
            },
          );
          const sourceUrl = `/reviews/${first.attemptId}/source`;
          /** Detect a response or connection failure before the handler reaches its synchronization point. */
          async function reachGate(event: string, token: string) {
            const reached = once(gate, event, { signal });
            const download = request(
              sourceUrl,
              "GET",
              token,
              undefined,
              signal,
            );
            downloads.push(download);
            await Promise.race([
              reached,
              download.then((response) => {
                throw new Error(
                  `source request returned HTTP ${response.status} before ${event}`,
                );
              }),
            ]);
          }
          try {
            await reachGate("transfer", lease.token);
            await reachGate("admitted", secondGrant.token);
            // Let the admitted HTTP handler enqueue its operation behind the first one.
            await setImmediate();
            assert.equal(transfers, 1);
            await revokeToken(
              state.database,
              secondGrant.id,
              config.service.owner,
            );
            gate.emit("release");
            const [allowed, denied] = await Promise.all(downloads);
            assert.equal(allowed.status, 200);
            assert.equal(
              Buffer.from(await allowed.arrayBuffer())
                .subarray(0, 4)
                .toString(),
              "PACK",
            );
            assert.equal(transfers, 2);
            assert.equal(denied.status, 503);
            assert.equal(denied.headers.get("x-razbor-object-format"), null);
            assert.ok((await denied.json()).error);
          } finally {
            gate.emit("release");
            controller.abort();
            await Promise.allSettled(downloads);
          }
        },
      );
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
          runner: { timeout_ms: 55000 },
          capabilities: { base_instructions: true },
        }),
        hostRoot: runnerRoot,
        dependenciesVolume: "fixture",
        network: "fixture",
      };
      const checkout = await createWorkspace(runner, first.attemptId);
      await t.test(
        "source pack production, download and strict import use their configured timeouts",
        async (t) => {
          const timers = t.mock.method(AbortSignal, "timeout");
          const spawns = t.mock.method(childProcess, "spawn");
          syncBuiltinESMExports();
          t.after(() => {
            spawns.mock.restore();
            syncBuiltinESMExports();
          });
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
          // Observe the real handoff without waiting for a large pack to consume either deadline.
          const budgets = timers.mock.calls.map((call) => call.arguments[0]);
          assert.ok(
            budgets.includes(config.service.sync_ms),
            "source stream deadline",
          );
          assert.equal(
            budgets.filter((ms) => ms === runner.runner.timeout_ms).length,
            2,
            "download and import deadlines",
          );
          const pack = spawns.mock.calls.find((call) =>
            call.arguments[1]?.includes("pack-objects"),
          );
          assert.equal(
            (pack?.arguments[2] as SpawnOptions | undefined)?.timeout,
            config.service.sync_ms,
          );
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
      assert.deepEqual(await (await request("/health", "GET", admin)).json(), {
        status: "ready",
        capabilities: { codebaseMemory: false },
      });
      await writeFile(
        path.join(root, "missing-binary"),
        "not the approved binary",
        { mode: 0o755 },
      );
      assert.equal(
        (await (await request("/health", "GET", admin)).json()).capabilities
          .codebaseMemory,
        false,
      );
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
