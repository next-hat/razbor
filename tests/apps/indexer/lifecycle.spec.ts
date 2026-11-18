import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  ensureDevelopmentWorkspaces,
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
    const state = await databaseFixture();
    const { administrator, database } = state;
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
      /** Observe fixture evidence through the administrative connection outside the read gate. */
      async function scanCount() {
        const result = await administrator.query(
          "select case when is_called then last_value else 0 end as count from fixture_workspace_scans",
        );
        return Number(result.rows[0].count);
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
      let admissions: number;
      try {
        await eventually(async () => (await scanCount()) > 0, 5000);
        await enable(true);
        const admitted = await fetch(
          `http://127.0.0.1:${port}/repositories/${repository}/index`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${admin}` },
            body: JSON.stringify({ prepare: false }),
          },
        );
        assert.equal(admitted.status, 200, await admitted.text());
        await administrator.query(
          "update index_workspaces set updated_at='2000-01-01' where public_id=$1",
          [workspace.id],
        );
        admissions = await scanCount();
      } finally {
        await administrator.query("select pg_advisory_unlock(419272, 2)");
      }
      await eventually(async () => (await scanCount()) >= admissions + 2, 8000);
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
      try {
        if (!shutdownChecked) await service.close();
      } finally {
        await state.close();
      }
    }
  },
);

test(
  "shutdown retains the service lock through an interrupted startup",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "razbor-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await databaseFixture();
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
    const service = new IndexService(config, admin, state.database);
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
      } finally {
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
      execFileSync("flock", [
        "--nonblock",
        path.join(root, "service.lock"),
        "true",
      ]);
    } finally {
      try {
        await service.close();
      } finally {
        await state.close();
      }
    }
  },
);
