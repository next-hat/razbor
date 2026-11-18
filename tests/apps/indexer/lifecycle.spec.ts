import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { codebaseMemoryUnavailableMessage } from "@razbor/contracts";
import {
  ensureDevelopmentWorkspaces,
  getRepository,
  issueToken,
  ownedWorkspaces,
  resolveRepository,
} from "@razbor/database";
import { applyRegistry, registrySchema } from "@razbor/database/registry";
import { indexerConfigSchema } from "@razbor/indexer/config";
import { IndexService } from "@razbor/indexer/service";

import {
  eventually,
  fixtureCommit,
  fixtureUpstream,
} from "@tests/apps/indexer/fixtures.js";
import { databaseFixture } from "@tests/packages/database/fixture.js";

const executable = process.env.CBM_EXECUTABLE;

test(
  "re-enabled workspaces survive a stale retirement scan and accept refresh by their retained ID",
  {
    skip: executable ? false : "set CBM_EXECUTABLE to run the indexed refresh",
    timeout: 90000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-retirement-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const admin = randomBytes(32).toString("base64url");
    const dataRoot = path.join(root, "data");
    const upstream = path.join(root, "upstream.git");
    const config = indexerConfigSchema.parse({
      service: {
        host: "127.0.0.1",
        port: 0,
        data_root: dataRoot,
        management_token: { env: "UNUSED_FIXTURE_ADMIN" },
      },
      memory: { executable },
    });
    const state = await databaseFixture();
    t.after(() => state.close());
    const { administrator, database } = state;
    const owner = config.service.owner;
    const service = new IndexService(config, admin, database);
    let shutdownChecked = false;
    try {
      await fixtureUpstream(upstream);
      const head = await fixtureCommit(upstream, {
        "sum.ts": "export const sum = (a: number, b: number) => a + b;\n",
      });
      const registry = registrySchema.parse({
        registry: { key: "retirement" },
        repositories: {
          fixture: {
            git: {
              branch: "master",
              upstream: "refs/remotes/origin/master",
              remotes: { origin: pathToFileURL(upstream).href },
              allow_local: true,
            },
            indexing: { owner, persistent: false },
          },
        },
      });
      await applyRegistry(database, registry);
      const port = await service.listen();
      const repository = await resolveRepository(database, "fixture");
      assert.ok(repository);
      await ensureDevelopmentWorkspaces(database, owner, dataRoot, repository);
      const [workspace] = await ownedWorkspaces(database, owner);
      const { token } = await issueToken(database, workspace.id, owner, {
        refresh: true,
      });
      /** Change only the repository setting; this fixture uses on-demand preparation throughout. */
      async function enable(value: boolean) {
        registry.repositories.fixture.codebaseMemoryEnabled = value;
        await applyRegistry(database, registry);
      }
      await enable(false);
      // Gate the first scan in PostgreSQL after it takes its MVCC snapshot. Other
      // connections may finish admission for the newly enabled repository meanwhile.
      await administrator.query(`
      select pg_advisory_lock(419272, 2);
      create sequence fixture_workspace_scans;
      create function fixture_observe_scan() returns boolean language plpgsql volatile
        security definer set search_path = pg_catalog, public as $$
      begin
        if nextval('public.fixture_workspace_scans') = 1 then
          perform pg_advisory_xact_lock(419272, 2);
        end if;
        return true;
      end; $$;
      alter table index_workspaces enable row level security;
      create policy fixture_read on index_workspaces for select using (fixture_observe_scan());
      create policy fixture_write on index_workspaces for update using (true) with check (true);
    `);
      /** Admit the current handle through the same reservation that serializes retirement. */
      async function admit() {
        const admitted = await fetch(
          `http://127.0.0.1:${port}/repositories/${repository}/index`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${admin}` },
            body: JSON.stringify({ prepare: false }),
            signal: AbortSignal.timeout(8000),
          },
        );
        assert.equal(admitted.status, 200, await admitted.text());
      }
      /** Read the durable retirement marker without affecting the observed scan count. */
      async function untouched() {
        return (
          await administrator.query(
            "select updated_at = '2000-01-01'::timestamptz as untouched from index_workspaces where public_id=$1",
            [workspace.id],
          )
        ).rows[0].untouched;
      }
      try {
        await eventually(
          async () =>
            (
              await administrator.query(
                "select is_called from fixture_workspace_scans",
              )
            ).rows[0].is_called,
          5000,
        );
        await enable(true);
        await admit();
        await administrator.query(
          "update index_workspaces set updated_at='2000-01-01' where public_id=$1",
          [workspace.id],
        );
        // The same reaper pass reconciles this on-demand repository only after
        // it has registered any retirement suggested by the held snapshot.
        await administrator.query(
          "update repositories set setup_state='error', setup_error=$1 where public_id=$2",
          [codebaseMemoryUnavailableMessage, repository],
        );
      } finally {
        await administrator.query("select pg_advisory_unlock(419272, 2)");
      }
      await eventually(
        async () =>
          (await getRepository(database, repository))?.setupState === "ready",
        8000,
      );
      // A scheduled retirement can still be running after reconciliation. This
      // request must wait for it, including its durable workspace-state write.
      await admit();
      assert.equal(
        await untouched(),
        true,
        "a stale disabled snapshot retired the newly admitted handle",
      );

      await enable(false);
      await eventually(async () => !(await untouched()));
      await enable(true);
      const refresh = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspace.id}/refresh`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(refresh.status, 200, await refresh.clone().text());
      assert.equal((await refresh.json()).headSha, head);
      // A registry outage must still stop the actual CBM daemon before the
      // lock is released, and preserve the checkout for the next owner.
      const runtime =
        "/tmp/rdm-" +
        createHash("sha256")
          .update(path.join(workspace.root, "state"))
          .digest("hex")
          .slice(0, 20);
      await access(runtime);
      await administrator.query(
        "alter table index_workspaces rename to fixture_offline_workspaces",
      );
      await assert.rejects(service.close(), /index_workspaces/);
      shutdownChecked = true;
      await assert.rejects(access(runtime), { code: "ENOENT" });
      await access(path.join(workspace.root, "repository"));
      execFileSync("flock", [
        "--nonblock",
        path.join(dataRoot, "service.lock"),
        "true",
      ]);
    } finally {
      if (!shutdownChecked) await service.close();
    }
  },
);

test(
  "shutdown retains the service lock through an interrupted startup",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const admin = randomBytes(32).toString("base64url");
    const config = indexerConfigSchema.parse({
      service: {
        host: "127.0.0.1",
        port: 0,
        data_root: root,
        management_token: { env: "UNUSED_FIXTURE_ADMIN" },
      },
      memory: { executable: path.join(root, "missing") },
    });
    const state = await databaseFixture();
    t.after(() => state.close());
    const service = new IndexService(config, admin, state.database);
    const lockPath = path.join(root, "service.lock");
    const probeLock = [
      "--nonblock",
      "--conflict-exit-code",
      "73",
      lockPath,
      "true",
    ];
    try {
      await applyRegistry(
        state.database,
        registrySchema.parse({
          registry: { key: "startup" },
          repositories: {
            fixture: {
              git: {
                branch: "master",
                upstream: "refs/remotes/origin/master",
                remotes: {
                  origin: pathToFileURL(path.join(root, "upstream.git")).href,
                },
                allow_local: true,
              },
              indexing: { owner: config.service.owner, persistent: true },
            },
          },
        }),
      );
      // Hold the ordinary provisioning transaction at its lock after this owner
      // acquires storage. The shutdown signal must wait for startup to relinquish it.
      await state.administrator.query("select pg_advisory_lock(748321, 3)");
      const spawned: ChildProcess[] = [];
      const children = channel("child_process");
      /** Keep the fixture's real guard handle so an early EOF can be observed through process exit. */
      function observeChild(message: unknown) {
        spawned.push((message as { process: ChildProcess }).process);
      }
      children.subscribe(observeChild);
      const listening = service.listen();
      const interrupted = assert.rejects(listening, /abort/i);
      try {
        await eventually(
          async () =>
            (
              await state.administrator.query(
                "select exists(select 1 from pg_locks where locktype='advisory' and classid=748321 and objid=3 and not granted) as waiting",
              )
            ).rows[0].waiting,
          5000,
        );
        const guard = spawned.find(
          (child) =>
            child.spawnfile === "flock" && child.spawnargs.includes(lockPath),
        );
        assert.ok(guard?.stdin, "fixture storage lock guard missing");
        void service.close().catch(() => {}); // The shared shutdown promise is awaited in finally.
        // If shutdown signalled EOF early, wait for the kernel lock to be
        // released instead of racing the child's exit with the flock probe.
        if (
          guard.stdin.writableEnded &&
          guard.exitCode === null &&
          guard.signalCode === null
        )
          await once(guard, "exit", { signal: AbortSignal.timeout(5000) });
        assert.throws(() => execFileSync("flock", probeLock), { status: 73 });
      } finally {
        children.unsubscribe(observeChild);
        // At the exact point shutdown returns, startup must already have
        // committed the mapping it was provisioning under this storage lock.
        const closing = service.close().then(async () => {
          const rows = await ownedWorkspaces(
            state.database,
            config.service.owner,
          );
          assert.equal(
            rows.length,
            1,
            "shutdown returned before provisioning committed",
          );
        });
        await state.administrator.query("select pg_advisory_unlock(748321, 3)");
        await Promise.all([interrupted, closing]);
      }
      await service.close();
      execFileSync("flock", probeLock);
    } finally {
      await service.close();
    }
  },
);
