import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  mergePolicySchema,
  type MergeAssessment,
  type PreviousFinding,
  type ReviewResult,
} from "@razbor/contracts";
import {
  beginAttempt,
  connectDatabase,
  finishAttempt,
  getRepository,
  listRepositories,
  listPullRequests,
  processMergeTriage,
  findingKey,
  submitReview,
  triageForge,
  triageOutstanding,
  updateRepositoryMergePolicy,
} from "@razbor/database";
import { migrate } from "@razbor/database/migrate";
import {
  applyRegistry,
  refreshRepository,
  registrySchema,
} from "@razbor/database/registry";
import {
  ForgejoInteractions,
  ForgeOperationError,
  type ForgeActor,
  type ForgeMergeState,
  type ForgeMergeCheckpoint,
  type ForgeMergeRequest,
} from "@razbor/forge-adapters";

import { databaseFixture } from "@tests/packages/database/fixture.js";

/** Release the blocked provider observation only after the competing operation has completed. */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

const baseSha = "a".repeat(40);

const headSha = "b".repeat(40);

const assessment: MergeAssessment = {
  confidence: 90,
  riskLevel: "low",
  reviewComplete: true,
  requiresHumanReview: false,
  reasons: ["Inspected the corrected guide and checked its links."],
  criticalAreas: [],
  verificationGaps: [],
  suggestedReviewers: ["alice", "unknown"],
};

test("Phase 2 data upgrades without authorizing a historical result", async (t) => {
  const fixture = await databaseFixture();
  const url = new URL(fixture.migrationUrl);
  url.pathname = "/upgrade_test";
  const upgrade = connectDatabase(url.href);
  t.after(async () => {
    await upgrade.close();
    await fixture.close();
  });
  await fixture.administrator.query(
    "create database upgrade_test owner razbor_migrator",
  );
  const dir = path.dirname(
    fileURLToPath(import.meta.resolve("@razbor/database/migrate")),
  );
  const migrations = path.resolve(dir, "../migrations");
  const phase2 = (await readdir(migrations))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < "0033_")
    .sort();
  assert.equal(phase2.length, 33);
  assert.equal(phase2.at(-1), "0032_gitlab_session_boundaries.sql");
  for (const file of phase2)
    await upgrade.pool.query(
      await readFile(path.join(migrations, file), "utf8"),
    );

  // Copy the journal entries that the fresh fixture actually installed through PR #5.
  await upgrade.pool.query(`create schema drizzle;
    create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
  const ledger =
    "select hash,created_at from drizzle.__drizzle_migrations order by created_at,hash";
  const current = (await fixture.administrator.query(ledger)).rows;
  assert.equal(current[31].created_at, "1790000000031");
  assert.equal(
    current[32].hash,
    "7d712b4f6b4633bd26adb8dad343ec24f23325855a96b8c5121f8ff428e18e43",
  );
  await upgrade.pool.query(
    "insert into drizzle.__drizzle_migrations (hash,created_at) select hash,created_at from json_to_recordset($1) as entry(hash text,created_at bigint)",
    [JSON.stringify(current.slice(0, phase2.length))],
  );
  const repo = (
    await upgrade.pool.query(
      "insert into repositories(public_id,config_key,managed_by,git,index_owner,persistent) values ('repo_0123456789abcdef','before','file','{}','local',false) returning id",
    )
  ).rows[0].id;
  const pr = (
    await upgrade.pool.query(
      "insert into pull_requests(public_id,repository_id,number,title,url,state,head_sha,base_sha) values('pr_0123456789abcdef',$1,7,'before','https://forge.invalid/pr/7','open',$2,$3) returning id",
      [repo, headSha, baseSha],
    )
  ).rows[0].id;
  await upgrade.pool.query(
    "insert into reviews(public_id,repository_id,head_sha,base_sha,source,status,result) values('rev_0123456789abcdef',$1,$2,$3,$4,'completed',$5)",
    [
      repo,
      headSha,
      baseSha,
      { pullRequest: { number: 7, baseSha } },
      { summary: "Legacy", findings: [] },
    ],
  );
  // Drizzle must still enter the lineage check at the old development high-water mark.
  await upgrade.pool.query(
    `update drizzle.__drizzle_migrations set created_at=1790000000033 where created_at=1790000000031`,
  );
  await assert.rejects(
    migrate(url.href),
    (error: Error) =>
      error.cause instanceof Error &&
      error.cause.message.includes("Unrecognized migration history at 0031"),
  );
  await upgrade.pool.query(
    `update drizzle.__drizzle_migrations set created_at=1790000000031 where created_at=1790000000033`,
  );
  await migrate(url.href);
  await migrate(url.href);
  assert.deepEqual((await upgrade.pool.query(ledger)).rows, current);
  await upgrade.pool.query(
    "select pending_open, open_retry_after from webhook_deliveries limit 0",
  );
  const [row] = (
    await upgrade.pool.query(
      "select r.merge_policy, r.merge_policy_version, v.merge_pull_request_id, v.source,v.result,v.merge_action,v.merge_write_stage,v.forge_approval from repositories r join reviews v on v.repository_id=r.id",
    )
  ).rows;
  assert.deepEqual(row.merge_policy, mergePolicySchema.parse({}));
  assert.equal(row.merge_policy_version, 1);
  assert.equal(row.merge_pull_request_id, pr);
  assert.equal(row.source.mergePolicy, undefined);
  assert.equal(row.result.summary, "Legacy");
  assert.equal(row.merge_action, null);
  assert.equal(row.merge_write_stage, null);
  assert.equal(row.forge_approval, null);

  // A preview may have stopped dispatching this PR after its vote was acknowledged.
  // Wake it on upgrade, preserving the original receipt and the stored decision.
  const receipt = { botId: "1", status: "approved" };
  await upgrade.pool.query(
    "update reviews set forge_approval=$2 where merge_pull_request_id=$1",
    [pr, receipt],
  );
  await upgrade.pool.query(
    "update pull_requests set merge_after=null where id=$1",
    [pr],
  );
  await upgrade.pool.query(
    "delete from drizzle.__drizzle_migrations where created_at=1790000000038",
  );
  await migrate(url.href);
  const [woken] = (
    await upgrade.pool.query(
      `select p.merge_after <= now() as due, r.forge_approval from pull_requests p
         join reviews r on r.merge_pull_request_id=p.id where p.id=$1`,
      [pr],
    )
  ).rows;
  assert.deepEqual(woken, { due: true, forge_approval: receipt });

  // The last PR #6 preview already had merge_policy and merge_write_stage.
  // Its earlier high-water mark skips GitLab boundaries unless the upgrade repairs them.
  const dropBoundary = `drop trigger record_deferred_boundary on webhook_deliveries;
     drop function razbor_record_deferred_boundary();
     alter table webhook_deliveries drop column boundary_number, drop column boundary_at`;
  await upgrade.pool.query(dropBoundary);
  await upgrade.pool.query(`alter table reviews drop column forge_approval;
     delete from drizzle.__drizzle_migrations where created_at in (1790000000032,1790000000037,1790000000038);
     update repositories set merge_policy_version=8, merge_policy=jsonb_set(merge_policy-'autoApprove','{policyMarkdown}','"Preview policy"')`);
  await upgrade.pool.query(
    `with hook as (
       insert into repository_webhooks(public_id, repository_id, managed_by, enabled, callback_base, secret, senders)
       values ('hook_0123456789abcdef', $1, 'file', true, '', '{}','[]') returning id)
     insert into webhook_deliveries(webhook_id,delivery_id,pending_open) select id,'pending-boundary',
       '{"kind":"reopened","number":7,"occurredAt":"2026-11-14T10:00:00Z"}' from hook`,
    [repo],
  );
  await migrate(url.href);
  await migrate(url.href);
  assert.deepEqual((await upgrade.pool.query(ledger)).rows, current);
  const repaired = (
    await upgrade.pool
      .query(`select boundary_number, boundary_at, r.merge_policy_version,
    r.merge_policy->'autoApprove' as approve from webhook_deliveries cross join repositories r`)
  ).rows[0];
  assert.equal(repaired.boundary_number, 7);
  assert.equal(repaired.boundary_at.toISOString(), "2026-11-14T10:00:00.000Z");
  assert.equal(repaired.merge_policy_version, 8);
  assert.equal(repaired.approve, false);

  // The original preview could have installed its own observation migration at
  // the same timestamp as Phase 2's GitLab boundary migration. Keep both records.
  const previewHash =
    "7708f6b258ac9c27160054b61e554311e97110557368b43f2475f208d96d7dbd";
  await upgrade.pool.query(dropBoundary);
  await upgrade.pool.query(
    `alter table webhook_deliveries drop column pending_open, drop column open_retry_after;
     alter table reviews drop column merge_write_stage, drop column forge_approval;
     delete from drizzle.__drizzle_migrations where created_at > 1790000000031;
     update repositories set merge_policy=merge_policy-'autoApprove'`,
  );
  await upgrade.pool.query(
    "update drizzle.__drizzle_migrations set hash=$1 where created_at=1790000000031",
    [previewHash],
  );
  await upgrade.pool.query(
    "insert into drizzle.__drizzle_migrations(created_at,hash) values (1790000000032,'unknown')",
  );
  await assert.rejects(
    migrate(url.href),
    /Unrecognized migration history at 0032/,
  );
  await upgrade.pool.query(
    "update drizzle.__drizzle_migrations set hash=$1 where created_at=1790000000032",
    [current[34].hash],
  );
  await migrate(url.href);
  await migrate(url.href);
  const previewLedger = (await upgrade.pool.query(ledger)).rows;
  const legacyObservation = previewLedger.find(
    (entry) =>
      entry.created_at === "1790000000032" && entry.hash === current[34].hash,
  );
  assert.ok(legacyObservation);
  assert.deepEqual(
    previewLedger.slice(32).filter((entry) => entry !== legacyObservation),
    current.slice(32),
  );
  assert.equal(previewLedger[31].hash, previewHash);
  const preview = (
    await upgrade.pool.query(
      "select r.merge_policy_version,r.merge_policy->>'policyMarkdown' as guidance,v.merge_pull_request_id,v.merge_write_stage,v.forge_approval from repositories r join reviews v on v.repository_id=r.id",
    )
  ).rows[0];
  assert.equal(preview.merge_policy_version, 8);
  assert.equal(preview.guidance, "Preview policy");
  assert.equal(preview.merge_pull_request_id, pr);
  assert.equal(preview.merge_write_stage, null);
  assert.equal(preview.forge_approval, null);
  await upgrade.pool.query(
    "select pending_open,open_retry_after,boundary_number,boundary_at from webhook_deliveries limit 0",
  );
  assert.equal(
    (
      await upgrade.pool.query(
        "select to_regclass('delivery_due_open') as name",
      )
    ).rows[0].name,
    "delivery_due_open",
  );
  // A settled GitHub dry run also needs its old eligibility comment revisited,
  // even when it has never cast a vote or submitted a native merge request.
  await upgrade.pool.query(
    `with configured as (
       insert into forge_instances(public_id, config_key, managed_by, type, api_url, web_url)
       values ('forge_0123456789abcdef','github','file','github','https://api.github.com','https://github.com')
       returning id)
     update repositories set forge_id=configured.id, selector='team/repo'
       from configured where repositories.id=$1`,
    [repo],
  );
  await upgrade.pool.query(
    "update reviews set merge_action='dry_run' where merge_pull_request_id=$1",
    [pr],
  );
  await upgrade.pool.query(
    "update pull_requests set merge_after=null where id=$1",
    [pr],
  );
  await upgrade.pool.query(
    "delete from drizzle.__drizzle_migrations where created_at=1790000000038",
  );
  await migrate(url.href);
  assert.equal(
    (
      await upgrade.pool.query(
        "select merge_after <= now() as due from pull_requests where id=$1",
        [pr],
      )
    ).rows[0].due,
    true,
  );
});

test(
  "PR triage persists policy snapshots, owned notifications and write fences across concurrent workers and restarts",
  { timeout: 120000 },
  async (t) => {
    const fixture = await databaseFixture();
    const db = fixture.database;
    // The second pool opens its first connection on recovery after the simulated crash.
    const restart = connectDatabase(fixture.url);
    t.after(async () => {
      await restart.close();
      await fixture.close();
    });
    const origin = "https://forge.invalid";
    const git = {
      branch: "main",
      upstream: "refs/remotes/origin/main",
      remotes: { origin: origin + "/team/repo.git" },
    };
    const policy = mergePolicySchema.parse({
      enabled: true,
      policyMarkdown: "Use human review for migrations.",
      humanReviewers: [
        "fallback",
        "missing1",
        "missing2",
        "missing3",
        "extra1",
        "alice",
        "extra2",
        "excess",
      ].map((username) => ({
        username,
        responsibilities: "Data",
        riskCategories: ["fallback", "alice"].includes(username) ? [] : ["low"],
        pathPatterns: username === "alice" ? ["db/**"] : [],
      })),
    });
    const config = registrySchema.parse({
      registry: { key: "test" },
      forges: {
        test: { type: "forgejo", api_url: origin + "/api/v1", web_url: origin },
      },
      repositories: {
        project: {
          forge: "test",
          selector: "team/repo",
          git,
          indexing: { owner: "fixture" },
          mergePolicy: policy,
        },
        other: { git, indexing: { owner: "fixture" } },
      },
    });
    await applyRegistry(db, config);
    const repos = await listRepositories(db);
    const repo = repos.find((r) => r.configKey === "project")!;
    assert.equal(
      (await getRepository(db, repos.find((r) => r.configKey === "other")!.id))
        ?.mergePolicy.enabled,
      false,
    );
    assert.equal(
      (await getRepository(db, repo.id))?.mergePolicy.minimumConfidence,
      90,
    );
    const meta = {
      id: 2,
      full_name: "team/repo",
      html_url: origin + "/team/repo",
      default_branch: "main",
      private: true,
      archived: false,
    };
    await db.pool.query(
      "update repositories set observed=$1, external_repository_id='2', verified_at=now() where public_id=$2",
      [
        {
          fullPath: meta.full_name,
          defaultBranch: "main",
          externalRepositoryId: "2",
        },
        repo.id,
      ],
    );
    const remoteComments = new Map<string, string>();
    const closingComments = new Map<string, string>();
    const noteStores = new Map([
      [1, remoteComments],
      [4, closingComments],
    ]);
    let nextOrdinaryNote = 200;
    const patchBodies: string[] = [];
    const priorFinding = {
      path: "guide.md",
      severity: "medium" as const,
      lineStart: 1,
      lineEnd: 1,
      title: "Broken link",
      body: "The guide links to the removed path.",
      failureScenario: "Opening the guide link returns 404.",
      suggestion: "Use the renamed route.",
    };
    let priorReviewId = "";
    let posts = 0;
    let delayedReservation = "";
    let closedReservation = "";
    let delayedMention = "";
    let delayedCorrection = "";
    let nextPatchOutcome: "delayed" | "lost acknowledgment" | undefined;
    let rejectedMention = false;
    let policyVoteHead = headSha;
    let denyFreshRevision = false;
    let denyMergedComments = false;
    const providerRequests = t.mock.method(
      globalThis,
      "fetch",
      async (input: URL, init?: RequestInit) => {
        const url = new URL(String(input));
        assert.equal(url.origin, origin);
        const route = url.pathname.replace("/api/v1/", "");
        const bot = { id: 1, login: "razbor" };
        if (route === "repos/team/repo") return Response.json(meta);
        if (route === "user") return Response.json(bot);
        if (route === "repos/team/repo/pulls/2/reviews")
          return Response.json([
            {
              id: 23,
              body: `<!-- razbor:${priorReviewId}:result -->`,
              commit_id: headSha,
              state: "COMMENT",
              user: bot,
            },
          ]);
        if (route === "repos/team/repo/pulls/2/reviews/23/comments")
          return Response.json([
            {
              id: 24,
              path: priorFinding.path,
              body: `Published prose\n<!-- razbor:${priorReviewId}:${findingKey(priorFinding)} -->`,
              user: bot,
              resolver: bot,
            },
          ]);
        if (route === "users/alice")
          return Response.json({
            id: 10,
            login: "alice",
            is_admin: false,
            active: true,
          });
        const pullRoute = /^repos\/team\/repo\/pulls\/(\d+)$/.exec(route);
        if (denyFreshRevision && pullRoute?.[1] === "18")
          return new Response(null, { status: 403 });
        if (pullRoute)
          return Response.json({
            number: Number(pullRoute[1]),
            state: "open",
            merged: false,
            draft: false,
            title: "One",
            user: { id: 7, login: "contributor" },
            html_url: origin + "/team/repo/pulls/" + pullRoute[1],
            base: { sha: baseSha, ref: "main" },
            head: {
              sha: Number(pullRoute[1]) === 10 ? policyVoteHead : headSha,
              ref: "docs",
            },
            merge_base: baseSha,
          });
        const collection = /^repos\/team\/repo\/issues\/(\d+)\/comments$/.exec(
          route,
        );
        const number = Number(collection?.[1]);
        if (denyMergedComments && number === 12)
          return new Response(null, { status: 403 });
        const stored = noteStores.get(number) ?? new Map<string, string>();
        if (collection) noteStores.set(number, stored);
        if (collection && init?.method === "POST") {
          const body = JSON.parse(String(init.body)).body;
          if (number !== 1 && number !== 4) {
            const id = nextOrdinaryNote++;
            stored.set(String(id), body);
            return Response.json({ id });
          }
          posts++;
          if (collection[1] === "4") {
            closedReservation = body;
            throw new Error("reservation POST delayed past closure");
          }
          if (posts === 1) {
            delayedReservation = body;
            throw new Error("lost acknowledgement");
          }
          const id = 76 + posts;
          stored.set(String(id), body);
          return Response.json({ id });
        }
        if (collection)
          return Response.json(
            url.searchParams.get("page") === "1"
              ? [...stored].map(([id, body]) => ({
                  id: Number(id),
                  body,
                  user: bot,
                  pull_request_url:
                    origin + "/team/repo/pulls/" + collection[1],
                  issue_url: "",
                }))
              : [],
          );
        if (route.startsWith("repos/team/repo/issues/comments/")) {
          const id = route.split("/").at(-1)!;
          const owner = [...noteStores].find(([, notes]) => notes.has(id));
          if (!owner) return new Response(null, { status: 404 });
          const [number, comments] = owner;
          if (init?.method === "DELETE") {
            comments.delete(id);
            return new Response(null, { status: 204 });
          }
          if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body)).body;
            if (!rejectedMention && body.includes("@alice")) {
              rejectedMention = true;
              return new Response(null, { status: 403 });
            }
            if (number === 1 || number === 4) patchBodies.push(body);
            if (!delayedMention && body.includes("@alice")) {
              delayedMention = body;
              throw new Error("mention PATCH delayed");
            }
            if (number === 1 && nextPatchOutcome === "delayed") {
              nextPatchOutcome = undefined;
              delayedCorrection = body;
              throw new Error("correction PATCH delayed");
            }
            comments.set(id, body);
            if (number === 1 && nextPatchOutcome === "lost acknowledgment") {
              nextPatchOutcome = undefined;
              throw new Error("applied PATCH response lost");
            }
          }
          return Response.json({
            id: Number(id),
            body: comments.get(id),
            user: bot,
            pull_request_url: origin + "/team/repo/pulls/" + number,
            issue_url: "",
          });
        }
        throw new Error("Unexpected fixture route " + route);
      },
    );
    let checks: ForgeMergeState = {
      state: "ready",
      reason: "all fixture requirements satisfied",
    };
    let pauseInspection:
      ((request: ForgeMergeRequest) => Promise<void>) | undefined;
    let writes = 0;
    let nextRateLimit: number | undefined;
    let denyNextSubmission = false;
    const inspections: number[] = [];
    const voteWrites: number[] = [];
    let voteFailure: "not-sent" | "rate-limited" | undefined;
    let votePreflight: "checks_pending" | "checks_unverified" | undefined;
    let providerVoteDeadline: number | undefined;
    const liveApprovalEvents: string[] = [];
    let visibleVote: "absent" | "approved" | "dismissed" = "absent";
    const approve = t.mock.method(
      ForgejoInteractions.prototype,
      "approveReview",
      async (
        request: ForgeMergeRequest,
        bot: ForgeActor,
        reconcileOnly: boolean,
        beforeWrite: () => Promise<void>,
        acknowledged?: boolean,
      ) => {
        assert.equal(request.headSha, headSha);
        assert.equal(request.baseSha, baseSha);
        assert.equal(bot.id, "1");
        if (request.number === 12) {
          assert.equal(request.reviewId, liveApprovedReview);
          assert.equal(request.externalRepositoryId, "2");
          assert.equal(request.baseBranch, "main");
          if (reconcileOnly) {
            assert.equal(acknowledged, true);
            assert.equal(await voteStatus(request.reviewId), "approved");
            liveApprovalEvents.push("read approved vote");
          }
        }
        if (reconcileOnly) return visibleVote;
        if (request.number === 8 && votePreflight) return votePreflight;
        await beforeWrite();
        assert.equal(await voteStatus(request.reviewId), "uncertain");
        if (request.number === 9 && voteFailure) {
          if (voteFailure === "not-sent")
            throw new ForgeOperationError("not-sent");
          providerVoteDeadline = Date.now() + 300_000;
          throw new ForgeOperationError(
            "unavailable",
            false,
            200,
            providerVoteDeadline,
          );
        }
        voteWrites.push(request.number);
        if (request.number === 12) {
          visibleVote = "approved";
          liveApprovalEvents.push("cast approval");
          return "approved";
        }
        if (request.number === 9)
          throw new ForgeOperationError("permission", false, 403);
        if (request.number === 13) return "approved";
        if (request.number === 10) {
          // Source or policy edits and PR revisions must wait across the wire write.
          await assert.rejects(
            restart.pool.query(
              "select id from repositories where public_id=$1 for update nowait",
              [repo.id],
            ),
            { code: "55P03" },
          );
          await assert.rejects(
            restart.pool.query(
              "select p.id from pull_requests p join repositories r on r.id=p.repository_id where r.public_id=$1 and p.number=$2 for update of p nowait",
              [repo.id, request.number],
            ),
            { code: "55P03" },
          );
          return "approved";
        }
        throw new ForgeOperationError("unavailable", true);
      },
    );
    let approvalChecks: ForgeMergeState = {
      state: "ready",
      reason: "approval_ready",
    };
    t.mock.method(
      ForgejoInteractions.prototype,
      "inspectApproval",
      async () => approvalChecks,
    );
    t.mock.method(
      ForgejoInteractions.prototype,
      "inspectMerge",
      async (request: ForgeMergeRequest) => {
        inspections.push(request.number);
        if (pauseInspection) await pauseInspection(request);
        return checks;
      },
    );
    const schedule = t.mock.method(
      ForgejoInteractions.prototype,
      "scheduleMerge",
      async (
        request: ForgeMergeRequest,
        _resumeOnly: boolean,
        checkpoint: ForgeMergeCheckpoint,
      ) => {
        if (request.number === 12) {
          assert.equal(request.reviewId, liveApprovedReview);
          await checkpoint("creating_check");
          await checkpoint("submitting");
          liveApprovalEvents.push("submit native merge");
          writes++;
          await checkpoint("armed");
          await checkpoint("releasing");
          liveApprovalEvents.push("release eligibility check");
          await checkpoint("acknowledged");
          return "merged";
        }
        if (request.number === 19) {
          await checkpoint("submitting");
          writes++;
          await checkpoint("acknowledged");
          return {
            state: "scheduled",
            guardState: "awaiting_checks",
            reason: "pipeline_pending",
          } as const;
        }
        if (nextRateLimit !== undefined) {
          const retryAt = nextRateLimit;
          nextRateLimit = undefined;
          await checkpoint("creating_check");
          await checkpoint("submitting");
          await checkpoint("creating_check");
          throw new ForgeOperationError("unavailable", false, 403, retryAt);
        }
        if (denyNextSubmission) {
          denyNextSubmission = false;
          await checkpoint("creating_check");
          await checkpoint("submitting");
          throw new ForgeOperationError("permission", false, 403);
        }
        await checkpoint("submitting");
        writes++;
        throw new ForgeOperationError("unavailable", true);
      },
    );
    let fallbackOnly = false;
    t.mock.method(
      ForgejoInteractions.prototype,
      "reviewerLogin",
      async (login: string) => {
        if (fallbackOnly) return login === "fallback" ? login : null;
        assert.notEqual(
          login,
          "excess",
          "provider lookups stop after three verified accounts",
        );
        return ["alice", "extra1", "extra2"].includes(login) ? login : null;
      },
    );
    /** Insert the stored PR that the console's review endpoint pins and authorizes. */
    async function pull(number: number) {
      const id = "pr_" + String(number).padStart(16, "0");
      await db.pool.query(
        "insert into pull_requests(public_id,repository_id,number,title,url,state,draft,head_branch,base_branch,head_sha,base_sha) select $1,id,$2,'Docs',$3,'open',false,'docs','main',$4,$5 from repositories where public_id=$6",
        [
          id,
          number,
          origin + "/team/repo/pulls/" + number,
          headSha,
          baseSha,
          repo.id,
        ],
      );
      return id;
    }
    /** Submit through normal review admission and complete the real durable lease with a local assessment. */
    async function complete(
      pr: string,
      score: number,
      routing?: Pick<MergeAssessment, "suggestedReviewers" | "pathOwners">,
      assessFindings?: (
        previous: PreviousFinding[],
      ) => Pick<ReviewResult, "findings" | "findingChecks">,
    ) {
      const review = await submitReview(
        db,
        { repositoryId: repo.id, baseSha, headSha },
        undefined,
        undefined,
        pr,
      );
      const attempt = await beginAttempt(db, review.id, "test", 30000);
      assert.equal(attempt.kind, "started");
      assert.equal(
        attempt.job.mergePolicy?.policy.policyMarkdown,
        policy.policyMarkdown,
      );
      await finishAttempt(db, review.id, attempt.attemptId, "test", {
        summary: "Read the guide",
        ...(assessFindings?.(attempt.job.previousFindings ?? []) ?? {
          findings: [],
        }),
        mergeAssessment: { ...assessment, confidence: score, ...routing },
      });
      return review.id;
    }
    /** Read the latest persisted decision and native-write state without contacting the fixture provider. */
    async function decision(id: string) {
      return (
        await db.pool.query(
          "select merge_decision->>'status' as status,merge_action as action from reviews where public_id=$1",
          [id],
        )
      ).rows[0];
    }
    /** Make this PR due immediately and return the deadline consumed by the next dispatch. */
    async function due(pr: string): Promise<Date> {
      const result = await db.pool.query<{ merge_after: Date }>(
        "update pull_requests set merge_after=now() where public_id=$1 returning merge_after",
        [pr],
      );
      return result.rows[0].merge_after;
    }
    /** Inspect the durable redispatch deadline without advancing the test clock. */
    async function deadline(pr: string): Promise<Date | null> {
      return (
        await db.pool.query(
          "select merge_after from pull_requests where public_id=$1",
          [pr],
        )
      ).rows[0].merge_after;
    }
    /** The provider has exactly one durable status comment on this PR. */
    function bodyFor(number: number) {
      const notes = noteStores.get(number);
      assert.equal(notes?.size, 1);
      return [...notes!.values()][0];
    }
    /** Read the vote recorded against the immutable review even after a worker restart. */
    async function voteStatus(id: string) {
      return (
        await db.pool.query(
          "select forge_approval->>'status' as status from reviews where public_id=$1",
          [id],
        )
      ).rows[0].status;
    }
    const first = await pull(1);
    const second = await pull(2);
    const human = await complete(first, 72, {
      suggestedReviewers: ["unknown"],
      pathOwners: ["alice"],
    });
    priorReviewId = await complete(second, 90);
    await db.pool.query(
      "update reviews set result=jsonb_set(result,'{findings}',$1::jsonb) where public_id=$2",
      [JSON.stringify([priorFinding]), priorReviewId],
    );
    await db.pool.query(
      "with hook as (insert into repository_webhooks(public_id,repository_id,managed_by,enabled,callback_base,secret,senders) select 'hook_0000000000000002',id,'fixture',true,'https://hooks.invalid','{}','[]' from repositories where public_id=$1 returning id,repository_id) insert into review_triggers(webhook_id,repository_id,review_id,origin,change) select hook.id,hook.repository_id,reviews.id,'automatic',$3 from hook,reviews where reviews.public_id=$2",
      [
        repo.id,
        priorReviewId,
        { number: 2, headSha, baseSha, mergeBase: baseSha },
      ],
    );
    await db.pool.query(
      "update dispatch_outbox set publication=$1 where review_id=(select id from reviews where public_id=$2)",
      [
        {
          state: "published",
          mode: "review",
          remoteId: "23",
          limitations: [
            "guide.md:1-1: replacement range was not validated; published prose advice only",
          ],
        },
        priorReviewId,
      ],
    );
    // These two console findings share a root cause, but only one fits in each
    // 200 KB admission snapshot. Resolve each immutable occurrence separately.
    const largeFinding = {
      ...priorFinding,
      body: priorFinding.body.repeat(4000),
    };
    const reported = await complete(second, 90, undefined, () => ({
      findings: [largeFinding, { ...largeFinding, lineStart: 4, lineEnd: 4 }],
    }));
    const partlyFixed = await complete(second, 90, undefined, (previous) => {
      assert.deepEqual(
        previous.map((f) => f.id),
        [`console:${reported}:0`],
      );
      return {
        findings: [],
        findingChecks: [
          {
            id: previous[0].id,
            status: "resolved",
            evidence: "The first link is fixed.",
          },
        ],
      };
    });
    const partial = await db.db.query.reviews.findFirst({
      where: (row, { eq }) => eq(row.publicId, partlyFixed),
    });
    assert.ok(partial);
    const client = await triageForge(db, partial.repositoryId);
    assert.equal(
      await triageOutstanding(
        db,
        partial.repositoryId,
        2,
        client.bot.id,
        client.api,
        partial,
      ),
      1,
      "the occurrence outside the admission budget still blocks merging",
    );
    await db.pool.query(
      "update pull_requests set head_sha=$1 where public_id=$2",
      ["c".repeat(40), second],
    );
    await db.pool.query(
      "update pull_requests set head_sha=$1 where public_id=$2",
      [headSha, second],
    );
    await complete(second, 90, undefined, (previous) => {
      assert.deepEqual(
        previous.map((f) => f.id),
        [`console:${reported}:0`],
        "the stale console resolution needs a fresh check even after the same head returns",
      );
      return {
        findings: [],
        findingChecks: [
          {
            id: previous[0].id,
            status: "resolved",
            evidence: "Rechecked the first link on the current revision.",
          },
        ],
      };
    });
    const clean = await complete(second, 90, undefined, (previous) => {
      assert.deepEqual(
        previous.map((f) => f.id),
        [`console:${reported}:1`],
      );
      assert.equal(previous[0].finding.lineStart, 4);
      return {
        findings: [],
        findingChecks: [
          {
            id: previous[0].id,
            status: "resolved",
            evidence: "The second link is now fixed as well.",
          },
        ],
      };
    });
    // The publication-time recap can predate a maintainer resolving a thread.
    // Only the current audit can determine whether historical findings still block.
    await db.pool.query(
      "update dispatch_outbox set publication=$1 where review_id=(select id from reviews where public_id=$2)",
      [{ state: "published", outstandingFindings: 1 }, clean],
    );
    await processMergeTriage(db);
    assert.deepEqual(await decision(clean), {
      status: "auto_merge_eligible",
      action: "dry_run",
    });
    assert.equal(writes, 0);
    assert.equal(approve.mock.callCount(), 0);
    const dryBody = bodyFor(2);
    assert.match(dryBody, /90\/100/);
    assert.match(dryBody, /threshold: 90\/100/);
    assert.match(dryBody, /[Nn]o actionable or outstanding/);
    assert.match(dryBody, /disabled for this dry run/);
    assert.ok(dryBody.includes(headSha));
    assert.ok(!dryBody.includes(policy.policyMarkdown));
    assert.ok(!dryBody.includes(assessment.reasons[0]));
    assert.doesNotMatch(
      dryBody,
      /@(alice|unknown)|provider confirmed Razbor’s approval/,
    );
    assert.equal(await deadline(second), null);
    const checkedBeforeIdle = inspections.filter(
      (number) => number === 2,
    ).length;
    await processMergeTriage(restart);
    assert.equal(
      inspections.filter((number) => number === 2).length,
      checkedBeforeIdle,
    );
    assert.equal(nextOrdinaryNote, 201);
    // A development HTTP setting must never send a triage preflight or retain
    // the old eligible preview when the configured origin cannot be trusted.
    for (const [forgeType, apiUrl, webUrl] of [
      ["forgejo", "http://forge.invalid/api", origin],
      ["gitlab", "http://forge.invalid/api", origin],
      ["forgejo", config.forges.test.api_url, "http://forge.invalid"],
    ]) {
      assert.deepEqual(await decision(clean), {
        status: "auto_merge_eligible",
        action: "dry_run",
      });
      const callsBeforeHttp = providerRequests.mock.callCount();
      await db.pool.query(
        "update forge_instances set type=$1, api_url=$2, web_url=$3, allow_http=true where config_key='test'",
        [forgeType, apiUrl, webUrl],
      );
      await due(second);
      await processMergeTriage(restart);
      assert.equal(providerRequests.mock.callCount(), callsBeforeHttp);
      assert.deepEqual(await decision(clean), {
        status: "blocked",
        action: null,
      });
      await db.pool.query(
        "update forge_instances set type='forgejo', api_url=$1, web_url=$2, allow_http=false where config_key='test'",
        [config.forges.test.api_url, config.forges.test.web_url],
      );
      await due(second);
      await processMergeTriage(db);
    }
    assert.deepEqual(await decision(clean), {
      status: "auto_merge_eligible",
      action: "dry_run",
    });
    assert.equal((await decision(human)).status, "human_review_required");
    const [escalation] = (
      await db.pool.query(
        "select merge_decision->'reviewers' as reviewers from reviews where public_id=$1",
        [human],
      )
    ).rows;
    assert.equal(escalation.reviewers[0], "alice");
    assert.equal(posts, 1);
    assert.doesNotMatch(delayedReservation, /@alice/);
    assert.equal(remoteComments.size, 0);
    // A modified reservation is never adopted, even when it still has an owned marker.
    remoteComments.set(
      "88",
      "Edited note\n" + delayedReservation.split("\n").at(-1),
    );
    await due(first);
    await processMergeTriage(restart);
    assert.ok(
      (
        await db.pool.query(
          "select escalation_comment->>'reservationRetryAt' as retry from pull_requests where public_id=$1",
          [first],
        )
      ).rows[0].retry,
    );
    assert.equal(posts, 1);
    remoteComments.delete("88");
    await due(first);
    await processMergeTriage(restart);
    assert.equal(posts, 1);
    await db.pool.query(
      "update pull_requests set merge_after=now(), escalation_comment=jsonb_set(escalation_comment,'{reservationRetryAt}','0') where public_id=$1",
      [first],
    );
    await Promise.all([processMergeTriage(db), processMergeTriage(restart)]);
    assert.equal(posts, 2);
    assert.equal(rejectedMention, true);
    assert.equal(delayedMention, "");
    const rejected = (
      await db.pool.query(
        "select escalation_comment from pull_requests where public_id=$1",
        [first],
      )
    ).rows[0].escalation_comment;
    assert.ok(!rejected.mentioned && !rejected.uncertainEdit);
    await due(first);
    await processMergeTriage(restart);
    assert.match(delayedMention, /@alice @extra1 @extra2/);
    assert.equal(remoteComments.get("78"), delayedReservation);
    // Two edits are still in flight. A third applies immediately but loses its response.
    nextPatchOutcome = "delayed";
    await due(first);
    await processMergeTriage(db);
    assert.doesNotMatch(delayedCorrection, /@alice/);
    assert.equal(remoteComments.get("78"), delayedReservation);
    nextPatchOutcome = "lost acknowledgment";
    await due(first);
    await processMergeTriage(restart);
    const appliedCorrection = remoteComments.get("78")!;
    assert.match(appliedCorrection, /Human review required/);
    assert.doesNotMatch(appliedCorrection, /@alice/);
    /** Compare the displayed decision across separately identifiable delivery attempts. */
    function visibleDecision(note: string) {
      return note.replace(/<!--[^>]*-->/g, "").trimEnd();
    }
    assert.equal(
      visibleDecision(appliedCorrection),
      visibleDecision(delayedCorrection),
    );
    assert.notEqual(appliedCorrection, delayedCorrection);
    // The first POST appears late. Only the committed ID ever contains the escalation.
    remoteComments.set("77", delayedReservation);
    await due(first);
    await processMergeTriage(restart);
    assert.deepEqual([...remoteComments.keys()], ["78"]);
    assert.equal(patchBodies.length, 3);
    assert.equal(
      (
        await db.pool.query(
          "select count(*)::int n from merge_escalation_history h join pull_requests p on p.id=h.pull_request_id where p.public_id=$1",
          [first],
        )
      ).rows[0].n,
      1,
    );
    // Later, acknowledged decisions do not settle either delayed request.
    await complete(first, 73);
    await processMergeTriage(db);
    const updatedBody = remoteComments.get("78")!;
    assert.match(updatedBody, /73\/100/);
    await db.pool.query(
      "update pull_requests set state='closed' where public_id=$1",
      [first],
    );
    await processMergeTriage(db);
    const resolvedBody = remoteComments.get("78");
    assert.ok(resolvedBody && resolvedBody !== updatedBody);
    const afterClose = (
      await db.pool.query(
        "select merge_after > now() as due, escalation_comment from pull_requests where public_id=$1",
        [first],
      )
    ).rows[0];
    assert.equal(afterClose.escalation_comment.pendingReservations, 0);
    assert.equal(afterClose.escalation_comment.uncertainEdit.length, 2);
    assert.equal(afterClose.due, true);
    // Deliver the older requests once each, in reverse order, after closure.
    remoteComments.set("78", delayedCorrection);
    await due(first);
    await processMergeTriage(restart);
    assert.equal(
      visibleDecision(remoteComments.get("78")!),
      visibleDecision(resolvedBody),
    );
    assert.ok((await deadline(first))!.getTime() > Date.now());
    remoteComments.set("78", delayedMention);
    await due(first);
    await processMergeTriage(restart);
    assert.equal(
      visibleDecision(remoteComments.get("78")!),
      visibleDecision(resolvedBody),
    );
    assert.equal(await deadline(first), null);
    const writesAfterSettlement = patchBodies.length;
    await processMergeTriage(db);
    assert.equal(patchBodies.length, writesAfterSettlement);
    // A preview worker did not record receipts. Seeing even the exact current body
    // cannot retire that fence until the old comment ID is confirmed deleted.
    await db.pool.query(
      "update pull_requests set merge_after=now(), escalation_comment=jsonb_set(escalation_comment,'{uncertainEdit}','true') where public_id=$1",
      [first],
    );
    await processMergeTriage(restart);
    assert.ok((await deadline(first))!.getTime() > Date.now());
    await db.pool.query(
      "update pull_requests set state='open' where public_id=$1",
      [first],
    );
    await complete(first, 73);
    remoteComments.delete("78");
    await due(first);
    await processMergeTriage(db);
    assert.equal(posts, 3);
    assert.match(remoteComments.get("79")!, /Human review required/);
    assert.doesNotMatch(remoteComments.get("79")!, /@/);
    assert.equal(
      (
        await db.pool.query(
          "select escalation_comment->>'uncertainEdit' as pending from pull_requests where public_id=$1",
          [first],
        )
      ).rows[0].pending,
      null,
    );
    fallbackOnly = true;
    const repeat = await complete(first, 100);
    await processMergeTriage(db);
    assert.equal((await decision(repeat)).status, "human_review_required");
    assert.equal(
      patchBodies.filter((body) => body.includes("@alice")).length,
      1,
    );
    assert.doesNotMatch(remoteComments.get("79")!, /@/);
    assert.match(remoteComments.get("79")!, /previously|human-controlled/);
    assert.match(remoteComments.get("79")!, /Suggested reviewers: `fallback`/);
    fallbackOnly = false;
    // A direct notification attempted by an older installation has no harmless
    // retry. Surface it after the bounded wait, then adopt it if it arrives.
    const legacyBody = remoteComments.get("79")!;
    remoteComments.delete("79");
    await db.pool.query(
      "update pull_requests set merge_after=now(), escalation_comment=$2 where public_id=$1",
      [
        first,
        {
          botId: "1",
          creatingBody: legacyBody,
          mentioned: true,
          reservationRetryAt: Date.now() - 1,
        },
      ],
    );
    await processMergeTriage(restart);
    const listed = (await listPullRequests(db, [repo.id])).find(
      (entry) => entry.id === first,
    );
    assert.equal(
      listed?.merge?.decision.reasons[0].code,
      "escalation_delivery_unconfirmed",
    );
    assert.equal(posts, 3);
    remoteComments.set("79", legacyBody);
    await due(first);
    await processMergeTriage(db);
    assert.equal(posts, 3);
    assert.equal(
      (
        await db.pool.query(
          "select escalation_comment->>'remoteId' id from pull_requests where public_id=$1",
          [first],
        )
      ).rows[0].id,
      "79",
    );

    const closing = await pull(4);
    await complete(closing, 72);
    await processMergeTriage(db);
    assert.match(closedReservation, /escalation-pending/);
    assert.doesNotMatch(closedReservation, /@/);
    const postsAtClose = posts;
    const editsAtClose = patchBodies.length;
    await db.pool.query(
      "update pull_requests set state='closed' where public_id=$1",
      [closing],
    );
    await processMergeTriage(restart);
    const closed = await db.pool.query(
      "select merge_after > now() as cleanup_pending from pull_requests where public_id=$1",
      [closing],
    );
    assert.equal(closed.rows[0].cleanup_pending, true);
    closingComments.set("92", closedReservation);
    await due(closing);
    await processMergeTriage(db);
    assert.equal(closingComments.size, 0);
    assert.equal(posts, postsAtClose);
    assert.equal(patchBodies.length, editsAtClose);

    const votePr = await pull(8);
    const beforeOptIn = await complete(votePr, 96);
    config.repositories.project.mergePolicy = { ...policy, autoApprove: true };
    await applyRegistry(db, config);
    await processMergeTriage(db);
    assert.equal((await decision(beforeOptIn)).status, "stale");
    assert.equal(approve.mock.callCount(), 0);
    const votingReview = await complete(votePr, 96);
    checks = { state: "blocked", reason: "github_schedule_owner_unbound" };
    for (const [code, secondPreflight] of [
      ["required_check_pending", undefined],
      ["required_check_unverified", undefined],
      ["required_check_pending", "checks_pending"],
      ["required_check_unverified", "checks_unverified"],
    ] as const) {
      votePreflight = secondPreflight;
      approvalChecks = secondPreflight
        ? { state: "ready", reason: "approval_ready" }
        : { state: "awaiting_checks", reason: code };
      const callsBefore = approve.mock.callCount();
      const started = Date.now();
      await processMergeTriage(restart);
      assert.equal(
        approve.mock.callCount(),
        callsBefore + (secondPreflight ? 1 : 0),
      );
      assert.equal(await voteStatus(votingReview), null);
      assert.deepEqual(voteWrites, []);
      const listed = (await listPullRequests(db, [repo.id])).find(
        (entry) => entry.id === votePr,
      );
      assert.deepEqual(
        listed?.merge?.decision.reasons.map((r) => r.code),
        code === "required_check_unverified"
          ? [checks.reason, code]
          : [checks.reason],
      );
      if (code === "required_check_unverified") {
        assert.equal(await deadline(votePr), null);
        assert.match(
          bodyFor(8),
          /cannot match a required GitHub ruleset check/,
        );
      } else {
        const nextPoll = (await deadline(votePr))!.getTime();
        assert.ok(nextPoll >= started + 60_000);
        assert.ok(nextPoll <= Date.now() + 60_000);
      }
      await due(votePr);
    }
    votePreflight = undefined;
    approvalChecks = { state: "ready", reason: "approval_ready" };
    checks = {
      state: "blocked",
      reason: "forgejo_schedule_does_not_pin_reviewed_head",
    };
    const escalatedAgain = await complete(first, 100);
    await processMergeTriage(db);
    assert.deepEqual(voteWrites, [8]);
    assert.equal(writes, 0);
    assert.equal(
      (await decision(escalatedAgain)).status,
      "human_review_required",
    );
    assert.equal(await voteStatus(votingReview), "uncertain");
    assert.ok((await deadline(votePr))!.getTime() > Date.now() + 30_000);
    assert.match(bodyFor(8), /96\/100/);
    assert.match(bodyFor(8), /not confirmed whether Razbor’s approval/);
    const replacementVoteReview = await complete(votePr, 97);
    await processMergeTriage(restart);
    assert.deepEqual(voteWrites, [8]);
    assert.equal(await voteStatus(replacementVoteReview), null);
    visibleVote = "approved";
    await due(votePr);
    await processMergeTriage(restart);
    assert.deepEqual(voteWrites, [8]);
    assert.equal(await voteStatus(votingReview), "approved");
    assert.equal(await deadline(votePr), null);
    const approvedBody = bodyFor(8);
    assert.match(approvedBody, /97\/100/);
    assert.match(approvedBody, /provider confirmed Razbor’s approval/);
    assert.match(approvedBody, /disabled for this dry run/);
    assert.equal((await decision(replacementVoteReview)).status, "blocked");
    visibleVote = "dismissed";
    await due(votePr);
    await processMergeTriage(restart);
    assert.deepEqual(voteWrites, [8]);
    assert.equal(await voteStatus(votingReview), "dismissed");
    assert.match(bodyFor(8), /approval was dismissed/);
    const deniedVotePr = await pull(9);
    const deniedVoteReview = await complete(deniedVotePr, 96);
    for (const failure of ["not-sent", "rate-limited"] as const) {
      voteFailure = failure;
      const dispatchStarted = Date.now();
      await processMergeTriage(restart);
      assert.equal(await voteStatus(deniedVoteReview), null);
      const scheduledRetry = (await deadline(deniedVotePr))!.getTime();
      if (failure === "rate-limited") {
        assert.ok(providerVoteDeadline !== undefined);
        assert.ok(scheduledRetry >= providerVoteDeadline);
      } else assert.ok(scheduledRetry >= dispatchStarted + 30_000);
      await due(deniedVotePr);
    }
    voteFailure = undefined;
    await processMergeTriage(db);
    assert.equal(await voteStatus(deniedVoteReview), "unavailable");
    await due(deniedVotePr);
    await processMergeTriage(restart);
    assert.deepEqual(voteWrites, [8, 9]);
    assert.equal(writes, 0);
    assert.equal(await deadline(deniedVotePr), null);
    assert.match(bodyFor(9), /could not approve/);
    checks = { state: "ready", reason: "provider_ready" };
    const acknowledgedPr = await pull(10);
    const acknowledgedVote = await complete(acknowledgedPr, 98);
    await Promise.all([processMergeTriage(db), processMergeTriage(restart)]);
    assert.deepEqual(voteWrites, [8, 9, 10]);
    assert.equal(await voteStatus(acknowledgedVote), "approved");
    assert.equal(await deadline(acknowledgedPr), null);
    assert.deepEqual(await decision(acknowledgedVote), {
      status: "auto_merge_eligible",
      action: "dry_run",
    });
    assert.match(bodyFor(10), /provider confirmed Razbor’s approval/);
    assert.equal(writes, 0);

    const escalatedPr = await pull(13);
    const uncertainPr = await pull(14);
    const previousApproval = await complete(escalatedPr, 99);
    const lostApproval = await complete(uncertainPr, 99);
    await processMergeTriage(db);
    assert.equal(await voteStatus(previousApproval), "approved");
    assert.equal(await voteStatus(lostApproval), "uncertain");
    const owners = new Map([
      [10, acknowledgedVote],
      [13, previousApproval],
      [14, lostApproval],
    ]);
    const withdrawn = new Set<number>();
    const withdrawalWrites: number[] = [];
    let lostVoteArrived = false;
    let policyWithdrawalConfirmed = false;
    let expireWithdrawal = true;
    t.mock.method(
      ForgejoInteractions.prototype,
      "retireApproval",
      async (
        request: ForgeMergeRequest,
        bot: ForgeActor,
        acknowledged: boolean,
        beforeWrite: () => Promise<void>,
        withdrawalUncertain?: boolean,
      ) => {
        if (request.number === 12) return "retired";
        assert.equal(request.reviewId, owners.get(request.number));
        assert.equal(request.externalRepositoryId, "2");
        assert.equal(request.baseBranch, "main");
        assert.equal(request.baseSha, baseSha);
        assert.equal(request.headSha, headSha);
        assert.equal(bot.id, "1");
        assert.equal(acknowledged, request.number !== 14);
        if (withdrawn.has(request.number)) {
          // Native readback confirms the previously submitted withdrawal.
          assert.equal(withdrawalUncertain, true);
          if (request.number === 10 && !policyWithdrawalConfirmed)
            return "unconfirmed";
          return "retired";
        }
        if (request.number === 14 && !lostVoteArrived) return "unconfirmed";
        await beforeWrite();
        const [intent] = (
          await restart.pool.query(
            "select forge_approval from reviews where public_id=$1",
            [request.reviewId],
          )
        ).rows;
        assert.equal(intent.forge_approval.retiring, true);
        assert.equal(intent.forge_approval.retirementSent, true);
        if (request.number === 13 && expireWithdrawal) {
          expireWithdrawal = false;
          throw new ForgeOperationError("not-sent");
        }
        withdrawn.add(request.number);
        withdrawalWrites.push(request.number);
        if (request.number !== 14)
          throw new ForgeOperationError("unavailable", true);
        return "retired";
      },
    );
    const humanAfterVote = await complete(escalatedPr, 70);
    const humanAfterLostVote = await complete(uncertainPr, 72);
    await processMergeTriage(db);
    assert.deepEqual(withdrawalWrites, []);
    const unsent = await restart.pool.query(
      "select forge_approval from reviews where public_id=$1",
      [previousApproval],
    );
    assert.equal(unsent.rows[0].forge_approval.retirementSent, undefined);
    await due(escalatedPr);
    await processMergeTriage(db);
    assert.deepEqual(withdrawalWrites, [13]);
    for (const reviewId of [humanAfterVote, humanAfterLostVote]) {
      const [human] = (
        await db.pool.query(
          `select p.human_escalated, r.merge_decision from reviews r
             join pull_requests p on p.id=r.merge_pull_request_id where r.public_id=$1`,
          [reviewId],
        )
      ).rows;
      assert.equal(human.human_escalated, true);
      assert.equal(human.merge_decision.status, "human_review_required");
      assert.ok(
        human.merge_decision.reasons.some(
          (reason: { code: string }) =>
            reason.code === "approval_retirement_pending",
        ),
      );
    }
    assert.ok(await deadline(escalatedPr));
    assert.ok(await deadline(uncertainPr));
    assert.match(bodyFor(13), /earlier Razbor approval may still count/);
    assert.match(bodyFor(14), /earlier Razbor approval may still count/);
    assert.equal(await voteStatus(lostApproval), "uncertain");
    await due(escalatedPr);
    await due(uncertainPr);
    await processMergeTriage(restart);
    assert.equal(await voteStatus(previousApproval), "dismissed");
    assert.equal(await voteStatus(lostApproval), "uncertain");
    assert.deepEqual(withdrawalWrites, [13]);
    lostVoteArrived = true;
    await due(uncertainPr);
    await processMergeTriage(restart);
    assert.equal(await voteStatus(lostApproval), "dismissed");
    assert.deepEqual(withdrawalWrites, [13, 14]);
    const afterWithdrawal = await complete(escalatedPr, 99);
    await processMergeTriage(restart);
    assert.equal(
      (await decision(afterWithdrawal)).status,
      "human_review_required",
    );
    assert.deepEqual(voteWrites, [8, 9, 10, 13, 14]);
    assert.equal(writes, 0);

    config.repositories.project.mergePolicy = {
      ...policy,
      dryRun: false,
      autoApprove: true,
    };
    // The first withdrawal reached the provider, but its response was lost.
    // The old policy must remain current until the retry can confirm retirement.
    await assert.rejects(applyRegistry(db, config), { status: 409 });
    assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 2);
    // A push and a fresh qualifying review cannot outrun a delayed withdrawal for the old head.
    policyVoteHead = "c".repeat(40);
    await db.pool.query(
      "update pull_requests set head_sha=$2 where public_id=$1",
      [acknowledgedPr, policyVoteHead],
    );
    const replacementHead = await complete(acknowledgedPr, 99);
    const approvalCalls = approve.mock.callCount();
    await processMergeTriage(restart);
    assert.equal(approve.mock.callCount(), approvalCalls);
    assert.equal((await decision(replacementHead)).status, "blocked");
    assert.equal(await voteStatus(replacementHead), null);
    assert.match(bodyFor(10), /earlier Razbor approval may still count/);
    policyWithdrawalConfirmed = true;
    await applyRegistry(db, config);
    assert.equal(await voteStatus(acknowledgedVote), "dismissed");
    assert.deepEqual(withdrawalWrites, [13, 14, 10]);
    const liveApprovalPr = await pull(11);
    const preparedAfterApproval = await complete(liveApprovalPr, 98);
    await db.pool.query(
      `update reviews set merge_action='writing', merge_write_stage='prepared',
         forge_approval=$2 where public_id=$1`,
      [preparedAfterApproval, { botId: "1", status: "approved" }],
    );
    // The forge withdrew a confirmed vote while the dispatcher was stopped.
    visibleVote = "dismissed";
    await processMergeTriage(restart);
    assert.equal(
      writes,
      0,
      "a withdrawn approval cannot release a prepared merge",
    );
    assert.equal(await voteStatus(preparedAfterApproval), "dismissed");
    assert.equal((await decision(preparedAfterApproval)).status, "blocked");
    assert.deepEqual(voteWrites, [8, 9, 10, 13, 14]);
    const readyForBoth = await pull(12);
    const liveApprovedReview = await complete(readyForBoth, 99);
    const nativeRetryAfter = Date.now() + 240_000;
    pauseInspection = async (request) => {
      if (request.reviewId === liveApprovedReview)
        throw new ForgeOperationError(
          "unavailable",
          false,
          429,
          nativeRetryAfter,
        );
    };
    await processMergeTriage(db);
    assert.deepEqual(liveApprovalEvents, ["cast approval"]);
    assert.equal(await voteStatus(liveApprovedReview), "approved");
    assert.equal((await deadline(readyForBoth))!.getTime(), nativeRetryAfter);
    await processMergeTriage(restart);
    assert.equal(inspections.filter((number) => number === 12).length, 1);
    pauseInspection = undefined;
    await due(readyForBoth);
    await processMergeTriage(db);
    assert.deepEqual(liveApprovalEvents, [
      "cast approval",
      "read approved vote",
      "read approved vote",
      "submit native merge",
      "read approved vote",
      "release eligibility check",
    ]);
    assert.equal(await voteStatus(liveApprovedReview), "approved");
    assert.deepEqual(await decision(liveApprovedReview), {
      status: "merged",
      action: "merged",
    });
    assert.deepEqual(voteWrites, [8, 9, 10, 13, 14, 12]);
    assert.equal(writes, 1);
    // A completed merge can still owe an update to its review comment.
    denyMergedComments = true;
    await db.pool.query(
      "update pull_requests set merge_after=now(), escalation_comment=$2 where public_id=$1",
      [readyForBoth, { botId: "1" }],
    );
    const commentDeniedAt = Date.now();
    await processMergeTriage(restart);
    assert.ok(
      (await deadline(readyForBoth))!.getTime() >= commentDeniedAt + 3_600_000,
    );
    assert.equal((await decision(liveApprovedReview)).action, "merged");
    denyMergedComments = false;
    await due(readyForBoth);
    await processMergeTriage(db);
    assert.equal(await deadline(readyForBoth), null);

    config.repositories.project.mergePolicy = {
      ...policy,
      dryRun: false,
      minimumConfidence: 80,
      requirePassingChecks: false,
    };
    await applyRegistry(db, config);
    await processMergeTriage(db);
    assert.equal((await decision(clean)).status, "stale");
    assert.equal(writes, 1);
    assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 4);
    assert.equal(
      (await getRepository(db, repos.find((r) => r.configKey === "other")!.id))
        ?.mergePolicyVersion,
      1,
    );
    await assert.rejects(
      updateRepositoryMergePolicy(db, repo.id, { version: 4, policy }),
      /registry file/,
    );
    const githubArmed = await pull(15);
    const githubNew = await pull(16);
    const oldSchedule = await complete(githubArmed, 99);
    const newRequest = await complete(githubNew, 99);
    await db.pool.query(
      "update reviews set merge_action='writing',merge_write_stage='armed' where public_id=$1",
      [oldSchedule],
    );
    checks = { state: "blocked", reason: "github_schedule_owner_unbound" };
    const beforeGithub = schedule.mock.callCount();
    const cancelOldSchedule = t.mock.method(
      ForgejoInteractions.prototype,
      "cancelMerge",
      async (request: ForgeMergeRequest) => {
        assert.equal(request.number, 15);
        assert.equal(request.reviewId, oldSchedule);
        assert.equal(request.headSha, headSha);
        assert.equal(request.writeStage, "armed");
        return "cancelled";
      },
    );
    await processMergeTriage(restart);
    assert.equal(cancelOldSchedule.mock.callCount(), 1);
    assert.deepEqual(await decision(oldSchedule), {
      status: "stale",
      action: "refused",
    });
    assert.deepEqual(await decision(newRequest), {
      status: "blocked",
      action: null,
    });
    assert.equal(await deadline(githubNew), null);
    assert.equal(schedule.mock.callCount(), beforeGithub);
    cancelOldSchedule.mock.restore();
    // A live capability read can fail before a native intent exists. Persist
    // the provider deadline so another dispatcher leaves this review asleep.
    const retryPr = await pull(17);
    const retryReview = await complete(retryPr, 95);
    let inspectionFailure = new ForgeOperationError("permission", false, 403);
    pauseInspection = async (request) => {
      if (request.reviewId === retryReview) throw inspectionFailure;
    };
    const deniedAt = Date.now();
    await processMergeTriage(db);
    assert.ok((await deadline(retryPr))!.getTime() >= deniedAt + 3_600_000);
    assert.deepEqual(await decision(retryReview), {
      status: "blocked",
      action: null,
    });
    await processMergeTriage(restart);
    assert.equal(inspections.filter((number) => number === 17).length, 1);
    const allowedAgainAt = Date.now() + 125_000;
    inspectionFailure = new ForgeOperationError(
      "unavailable",
      false,
      429,
      allowedAgainAt,
    );
    await due(retryPr);
    await processMergeTriage(restart);
    assert.equal((await deadline(retryPr))!.getTime(), allowedAgainAt);
    await processMergeTriage(db);
    assert.equal(inspections.filter((number) => number === 17).length, 2);
    assert.equal(schedule.mock.callCount(), beforeGithub);
    pauseInspection = undefined;
    // A rotated bot cannot edit the durable escalation owned by its predecessor.
    const rotatedPr = await pull(18);
    const rotatedReview = await complete(rotatedPr, 70);
    await db.pool.query(
      "update pull_requests set escalation_comment=$2 where public_id=$1",
      [rotatedPr, { botId: "42", remoteId: "700" }],
    );
    // A denied fresh revision read blocks the decision before any note is touched.
    denyFreshRevision = true;
    const beforeRevision = Date.now();
    await processMergeTriage(db);
    assert.deepEqual(await decision(rotatedReview), {
      status: "blocked",
      action: null,
    });
    assert.ok(
      (await deadline(rotatedPr))!.getTime() >= beforeRevision + 3_600_000,
    );
    assert.equal(noteStores.has(18), false);
    denyFreshRevision = false;
    await due(rotatedPr);
    const beforeEscalation = Date.now();
    await processMergeTriage(restart);
    assert.ok(
      (await deadline(rotatedPr))!.getTime() >= beforeEscalation + 3_600_000,
    );
    /** Count provider revision reads for the PR whose escalation has the previous bot ID. */
    const rotatedReads = () =>
      providerRequests.mock.calls.filter((call) =>
        String(call.arguments[0]).endsWith("/pulls/18"),
      ).length;
    assert.equal(rotatedReads(), 2);
    await processMergeTriage(db);
    assert.equal(rotatedReads(), 2);
    assert.equal(noteStores.has(18), false);
    checks = { state: "ready", reason: "provider_ready" };
    const live = await complete(second, 95);
    // Restart after the durable intent, before any provider mutation was attempted.
    await db.pool.query(
      "update reviews set merge_action='writing',merge_write_stage='prepared' where public_id=$1",
      [live],
    );

    /** Always release the inspecting worker, including when it fails before reaching the barrier. */
    async function whileInspectionPaused(
      compete: () => Promise<void>,
      reviewId?: string,
    ) {
      const entered = barrier();
      const release = barrier();
      pauseInspection = async (request) => {
        if (reviewId && reviewId !== request.reviewId) return;
        entered.resolve();
        await release.promise;
      };
      const worker = processMergeTriage(db);
      try {
        await Promise.race([
          entered.promise,
          worker.then(() => {
            throw new Error("Worker finished before inspection");
          }),
        ]);
        await compete();
      } finally {
        release.resolve();
        pauseInspection = undefined;
        await worker;
      }
    }
    await whileInspectionPaused(() => processMergeTriage(restart));
    assert.equal(writes, 2);
    assert.deepEqual(await decision(live), {
      status: "blocked",
      action: "uncertain",
    });
    await due(second);
    await processMergeTriage(restart);
    assert.equal(writes, 2);
    checks = {
      state: "scheduled",
      guardState: "awaiting_checks",
      reason: "pipeline_pending",
    };
    await due(second);
    await processMergeTriage(restart);
    assert.deepEqual(await decision(live), {
      status: "awaiting_checks",
      action: "scheduled",
    });
    assert.equal(writes, 2);
    checks = { state: "merged", reason: "verified" };
    await due(second);
    await processMergeTriage(restart);
    assert.deepEqual(await decision(live), {
      status: "merged",
      action: "merged",
    });
    assert.equal(writes, 2);
    const third = await pull(3);
    const superseded = await complete(third, 95);
    checks = { state: "ready", reason: "verified" };
    await whileInspectionPaused(async () => {
      await db.pool.query(
        "update pull_requests set head_sha=$1 where public_id=$2",
        ["c".repeat(40), third],
      );
      await db.pool.query(
        "update pull_requests set head_sha=$1 where public_id=$2",
        [headSha, third],
      );
    });
    await processMergeTriage(db);
    assert.equal((await decision(superseded)).status, "stale");
    assert.equal(writes, 2);

    const previewPr = await pull(5);
    const oldCheck = await complete(previewPr, 95);
    const oldDecision = {
      status: "stale",
      reviewers: [],
      reasons: [
        {
          code: "operator_resolved",
          message: "Operator resolved the incident.",
        },
      ],
    };
    await db.pool.query(
      "update reviews set merge_action='refused',merge_write_stage='creating_check',merge_decision=$2 where public_id=$1",
      [oldCheck, oldDecision],
    );
    const replacement = await complete(previewPr, 95);
    checks = {
      state: "blocked",
      reason: "conflicting_eligibility_check",
      pendingCheckReviewId: oldCheck,
    };
    let expectedCheckOwner = oldCheck;
    const cancelPreview = t.mock.method(
      ForgejoInteractions.prototype,
      "cancelMerge",
      async (request: ForgeMergeRequest) => {
        assert.equal(request.reviewId, expectedCheckOwner);
        assert.equal(request.writeStage, "creating_check");
        checks = { state: "awaiting_checks", reason: "required_check_pending" };
        return "cancelled";
      },
    );
    await processMergeTriage(restart);
    assert.equal(cancelPreview.mock.callCount(), 0);
    assert.equal((await decision(replacement)).status, "blocked");
    oldDecision.reasons = [
      {
        code: "schedule_invalidated",
        message: "The previous merge authorization was retired.",
      },
    ];
    await db.pool.query(
      "update reviews set merge_decision=$2 where public_id=$1",
      [oldCheck, oldDecision],
    );
    await due(previewPr);
    let newest = "";
    await whileInspectionPaused(async () => {
      newest = await complete(previewPr, 95);
    }, replacement);
    assert.equal(cancelPreview.mock.callCount(), 0);
    await due(previewPr);
    await processMergeTriage(restart);
    assert.equal(cancelPreview.mock.callCount(), 1);
    assert.equal((await decision(newest)).status, "awaiting_checks");
    assert.equal(writes, 2);
    checks = { state: "ready", reason: "provider_ready" };
    await due(previewPr);
    await processMergeTriage(restart);
    assert.equal(writes, 3);

    const limitedPr = await pull(6);
    const limited = await complete(limitedPr, 95);
    const retryAt = Date.now() + 180000;
    nextRateLimit = retryAt;
    await processMergeTriage(db);
    const limitedRow = (
      await db.pool.query(
        "select merge_action,merge_write_stage,merge_decision,p.merge_after from reviews r join pull_requests p on p.id=r.merge_pull_request_id where r.public_id=$1",
        [limited],
      )
    ).rows[0];
    assert.equal(limitedRow.merge_write_stage, "creating_check");
    assert.equal(limitedRow.merge_action, "writing");
    assert.equal(
      limitedRow.merge_decision.reasons[0].code,
      "provider_rate_limited",
    );
    assert.equal(limitedRow.merge_after.getTime(), retryAt);
    await processMergeTriage(restart);
    assert.equal(writes, 3);
    // Make the next observation explicitly report that an uncertain create is still unseen.
    checks = { state: "blocked", reason: "eligibility_check_unconfirmed" };
    await due(limitedPr);
    await processMergeTriage(restart);
    const missing = (
      await db.pool.query(
        "select merge_decision,merge_action from reviews where public_id=$1",
        [limited],
      )
    ).rows[0];
    assert.equal(missing.merge_action, "uncertain");
    assert.equal(
      missing.merge_decision.reasons[0].code,
      "eligibility_check_unconfirmed",
    );
    assert.match(
      missing.merge_decision.reasons[0].message,
      /operator recovery/,
    );
    assert.equal(writes, 3);

    const deniedPr = await pull(7);
    const denied = await complete(deniedPr, 95);
    checks = { state: "ready", reason: "provider_ready" };
    denyNextSubmission = true;
    await processMergeTriage(db);
    const refusal = (
      await db.pool.query(
        "select merge_action,merge_write_stage,merge_decision from reviews where public_id=$1",
        [denied],
      )
    ).rows[0];
    assert.equal(refusal.merge_action, "refused");
    assert.equal(refusal.merge_write_stage, "creating_check");
    assert.equal(
      refusal.merge_decision.reasons[0].code,
      "native_submission_refused",
    );
    await due(deniedPr);
    await processMergeTriage(restart);
    assert.equal(writes, 3);
    const afterDenial = await complete(deniedPr, 95);
    expectedCheckOwner = denied;
    checks = {
      state: "blocked",
      reason: "conflicting_eligibility_check",
      pendingCheckReviewId: denied,
    };
    await processMergeTriage(restart);
    assert.equal(cancelPreview.mock.callCount(), 2);
    assert.equal((await decision(afterDenial)).status, "awaiting_checks");
    assert.equal(writes, 3);

    // GitLab accepted this operation, but its PUT readback already saw pending native CI.
    // Provider requirements remain binding even with optional policy checks disabled.
    const scheduledPr = await pull(19);
    const scheduledReview = await complete(scheduledPr, 95);
    checks = { state: "ready", reason: "provider_ready" };
    for (const [guardState, reason] of [
      ["awaiting_checks", "pipeline_pending"],
      ["blocked", "pipeline_failed"],
      ["blocked", "merge_restrictions"],
    ] as const) {
      if (reason !== "pipeline_pending")
        checks = { state: "scheduled", guardState, reason };
      const dueAt = await due(scheduledPr);
      await processMergeTriage(restart);
      assert.deepEqual(await decision(scheduledReview), {
        status: guardState,
        action: "scheduled",
      });
      const listed = (await listPullRequests(db, [repo.id])).find(
        (pr) => pr.id === scheduledPr,
      )?.merge;
      assert.equal(listed?.action, "scheduled");
      assert.equal(listed.decision.status, guardState);
      assert.deepEqual(
        listed.decision.reasons.map((item) => item.code),
        [reason, "provider_scheduled"],
      );
      const nextPoll = await deadline(scheduledPr);
      assert.ok(
        nextPoll && nextPoll > dueAt && nextPoll.getTime() > Date.now(),
        `Expected a future poll deadline after ${reason}`,
      );
    }
    pauseInspection = async (request) => {
      if (request.number === 19) throw new ForgeOperationError("unavailable");
    };
    await due(scheduledPr);
    await processMergeTriage(restart);
    pauseInspection = undefined;
    assert.deepEqual(await decision(scheduledReview), {
      status: "blocked",
      action: "scheduled",
    });
    const unconfirmed = (await listPullRequests(db, [repo.id])).find(
      (entry) => entry.id === scheduledPr,
    )?.merge;
    assert.equal(
      unconfirmed?.decision.reasons[0].code,
      "unresolved_provider_merge",
    );
    checks = { state: "scheduled", reason: "provider_scheduled" };
    await due(scheduledPr);
    await processMergeTriage(restart);
    assert.deepEqual(await decision(scheduledReview), {
      status: "auto_merge_eligible",
      action: "scheduled",
    });
    assert.equal(
      schedule.mock.calls.filter((call) => call.arguments[0].number === 19)
        .length,
      1,
    );
    assert.equal(writes, 4);

    // Ten older PRs share a busy repository. The unrelated repository must get
    // a dispatch slot in this same batch, even if its own review queue is empty.
    const free = repos.find((r) => r.configKey === "other")!;
    await db.pool.query(
      `insert into pull_requests (public_id,repository_id,number,title,url,state,head_sha,base_sha,merge_after)
      select 'pr_' || lpad(n::text,16,'0'), r.id,n,'Queued','https://forge.invalid/pr/'||n,'open',$3,$4,
        case when n=30 then now() else now()-interval '1 hour' end
      from generate_series(20,30) n join repositories r on r.public_id=case when n=30 then $2 else $1 end`,
      [repo.id, free.id, headSha, baseSha],
    );
    const holder = await db.pool.connect();
    const lock = "repository:" + repo.id;
    try {
      await holder.query("select pg_advisory_lock(748322,hashtext($1))", [
        lock,
      ]);
      await processMergeTriage(restart);
      const freeRow = await db.pool.query(
        "select merge_after from pull_requests where number=30",
      );
      assert.equal(freeRow.rows[0].merge_after, null);
    } finally {
      try {
        await holder.query("select pg_advisory_unlock(748322,hashtext($1))", [
          lock,
        ]);
      } finally {
        holder.release();
      }
    }
  },
);

test(
  "policy replacement waits for acknowledged native authority and preserves a lost write fence",
  { timeout: 60000 },
  async (t) => {
    const fixture = await databaseFixture();
    t.after(() => fixture.close());
    const db = fixture.database;
    const origin = "https://forge.invalid";
    const metadata = {
      id: 2,
      full_name: "team/repo",
      html_url: origin + "/team/repo",
      default_branch: "main",
      private: true,
      archived: false,
    };
    t.mock.method(globalThis, "fetch", async (input: URL) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      if (url.pathname === "/api/v1/repos/team/repo")
        return Response.json(metadata);
      if (url.pathname === "/api/v1/user")
        return Response.json({ id: 7, login: "bot" });
      throw new Error("Unexpected fixture provider read");
    });
    const original = mergePolicySchema.parse({ enabled: true, dryRun: false });
    const config = registrySchema.parse({
      registry: { key: "fixture" },
      forges: {
        forge: {
          type: "forgejo",
          api_url: origin + "/api/v1",
          web_url: origin,
        },
      },
      repositories: {
        repo: {
          forge: "forge",
          selector: "team/repo",
          git: {
            branch: "main",
            upstream: "refs/remotes/origin/main",
            remotes: { origin: origin + "/team/repo.git" },
          },
          indexing: { owner: "fixture" },
          mergePolicy: original,
        },
      },
    });
    await applyRegistry(db, config);
    const [repo] = await listRepositories(db);
    await db.pool.query(
      "update repositories set verified_at=now(),external_repository_id='2',observed=$1 where public_id=$2",
      [
        {
          externalRepositoryId: "2",
          fullPath: "team/repo",
          defaultBranch: "main",
        },
        repo.id,
      ],
    );
    const pr = "pr_0000000000000001";
    await db.pool.query(
      "insert into pull_requests(public_id,repository_id,number,title,url,state,draft,head_branch,base_branch,head_sha,base_sha) select $1,id,1,'Docs',$2,'open',false,'docs','main',$3,$4 from repositories where public_id=$5",
      [pr, origin + "/team/repo/pulls/1", headSha, baseSha, repo.id],
    );
    const review = await submitReview(
      db,
      { repositoryId: repo.id, headSha, baseSha },
      undefined,
      undefined,
      pr,
    );
    await db.pool.query(
      "update reviews set merge_action='uncertain' where public_id=$1",
      [review.id],
    );
    const remote = t.mock.method(
      ForgejoInteractions.prototype,
      "inspectMerge",
      async () => ({ state: "ready", reason: "fixture" }),
    );
    const entered = barrier();
    const released = barrier();
    const cancel = t.mock.method(
      ForgejoInteractions.prototype,
      "cancelMerge",
      async () => {
        entered.resolve();
        await released.promise;
        return "absent";
      },
    );
    const changed = { ...original, minimumConfidence: 100 };
    const differentSelector = structuredClone(config);
    differentSelector.repositories.repo.selector = "team/renamed";
    const verified = await getRepository(db, repo.id);
    await assert.rejects(applyRegistry(db, differentSelector), { status: 409 });
    assert.deepEqual(await getRepository(db, repo.id), verified);
    config.repositories.repo.mergePolicy = changed;
    await assert.rejects(applyRegistry(db, config), { status: 409 });
    config.forges.forge.credential = {
      env: "RAZBOR_TRIAGE_FIXTURE_CREDENTIAL",
    };
    await assert.rejects(
      applyRegistry(db, config),
      /empty \[repositories\] table/,
    );
    await applyRegistry(db, { ...config, repositories: {} });
    assert.deepEqual(
      (
        await db.pool.query(
          "select credential from forge_instances where config_key='forge'",
        )
      ).rows[0].credential,
      config.forges.forge.credential,
    );
    assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 1);
    // The rest of this fixture uses an anonymous controlled adapter.
    delete config.forges.forge.credential;
    await applyRegistry(db, { ...config, repositories: {} });

    assert.equal(cancel.mock.callCount(), 0);
    assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 1);
    assert.equal(
      (
        await db.pool.query(
          "select merge_action from reviews where public_id=$1",
          [review.id],
        )
      ).rows[0].merge_action,
      "uncertain",
    );

    // Persist an observed acknowledgement before attempting cancellation. If the
    // provider/operator removes it during an interruption, absence is now actionable.
    let observed = true;
    remote.mock.mockImplementation(async () => ({
      state: observed ? "scheduled" : "ready",
      reason: "fixture",
    }));
    cancel.mock.mockImplementationOnce(async () => {
      observed = false;
      throw new ForgeOperationError("unavailable", true);
    });
    await assert.rejects(applyRegistry(db, config), { status: 409 });
    assert.equal(
      (
        await db.pool.query(
          "select merge_action from reviews where public_id=$1",
          [review.id],
        )
      ).rows[0].merge_action,
      "scheduled",
    );
    const save = applyRegistry(db, config);
    try {
      await Promise.race([
        entered.promise,
        save.then(() => {
          throw new Error("Saved before cancellation readback");
        }),
      ]);
      assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 1);
    } finally {
      released.resolve();
      await save;
    }
    assert.equal(cancel.mock.callCount(), 2);
    assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 2);
    assert.equal(
      (
        await db.pool.query(
          "select merge_action from reviews where public_id=$1",
          [review.id],
        )
      ).rows[0].merge_action,
      "refused",
    );

    // A Git-only edit must settle the original binding and invalidate its review,
    // even when re-verification returns the same provider identity and commit IDs.
    const beforeSourceEdit = await submitReview(
      db,
      { repositoryId: repo.id, headSha, baseSha },
      undefined,
      undefined,
      pr,
    );
    await db.pool.query(
      "update reviews set merge_action='scheduled' where public_id=$1",
      [beforeSourceEdit.id],
    );
    await db.pool.query(
      "update pull_requests set merge_after=null where public_id=$1",
      [pr],
    );
    cancel.mock.mockImplementationOnce(async () => "cancelled");
    config.repositories.repo.git.branch = "release";
    config.repositories.repo.git.upstream = "refs/remotes/origin/release";
    await applyRegistry(db, config);
    assert.equal(cancel.mock.callCount(), 3);
    const unverified = await getRepository(db, repo.id);
    assert.equal(unverified?.branch, "release");
    assert.equal(unverified?.verifiedAt, null);
    assert.equal(unverified?.mergePolicyVersion, 2);
    const sourceEdit = (
      await db.pool.query(
        `select p.merge_revision = (r.source->>'mergeRevision')::int + 1 as stale,
          p.merge_after <= now() as due, r.merge_action
         from reviews r join pull_requests p on p.id=r.merge_pull_request_id
         where r.public_id=$1`,
        [beforeSourceEdit.id],
      )
    ).rows[0];
    assert.deepEqual(sourceEdit, {
      stale: true,
      due: true,
      merge_action: "refused",
    });
    const reverified = await refreshRepository(db, repo.id);
    assert.equal(
      reverified?.externalRepositoryId,
      verified?.externalRepositoryId,
    );
    assert.ok(reverified?.verifiedAt);
    await processMergeTriage(db);
    assert.equal(
      (
        await db.pool.query(
          "select merge_decision->>'status' as status from reviews where public_id=$1",
          [beforeSourceEdit.id],
        )
      ).rows[0].status,
      "stale",
    );

    await db.pool.query(
      "update repositories set managed_by='ui',config_key='ui-'||public_id where public_id=$1",
      [repo.id],
    );
    await db.pool.query(
      "update reviews set merge_action='writing' where public_id=$1",
      [review.id],
    );
    await assert.rejects(
      updateRepositoryMergePolicy(db, repo.id, {
        version: 2,
        policy: original,
      }),
      { status: 409 },
    );
    remote.mock.mockImplementation(async () => ({
      state: "merged",
      reason: "fixture",
    }));
    await updateRepositoryMergePolicy(db, repo.id, {
      version: 2,
      policy: original,
    });
    assert.equal((await getRepository(db, repo.id))?.mergePolicyVersion, 3);
    assert.equal(
      (
        await db.pool.query(
          "select merge_action from reviews where public_id=$1",
          [review.id],
        )
      ).rows[0].merge_action,
      "merged",
    );

    // A delayed check creation needs its own positive cancellation receipt.
    await db.pool.query(
      "update reviews set merge_action='writing',merge_write_stage='creating_check' where public_id=$1",
      [review.id],
    );
    remote.mock.mockImplementation(async () => ({
      state: "ready",
      reason: "fixture",
    }));
    cancel.mock.mockImplementationOnce(async () => "absent");
    await assert.rejects(
      updateRepositoryMergePolicy(db, repo.id, { version: 3, policy: changed }),
      { status: 409 },
    );
    assert.equal(
      (
        await db.pool.query(
          "select merge_action from reviews where public_id=$1",
          [review.id],
        )
      ).rows[0].merge_action,
      "writing",
    );
    cancel.mock.mockImplementationOnce(async () => "cancelled");
    await updateRepositoryMergePolicy(db, repo.id, {
      version: 3,
      policy: changed,
    });
    assert.equal(
      (
        await db.pool.query(
          "select merge_action from reviews where public_id=$1",
          [review.id],
        )
      ).rows[0].merge_action,
      "refused",
    );

    // Run the operator's published maintenance transaction against a legacy ambiguous
    // action. Only an exact review and SHA can wake this PR and append its audit entry.
    await db.pool.query(
      "update reviews set merge_action='uncertain',merge_write_stage=null where public_id=$1",
      [review.id],
    );
    const guide = await readFile(
      new URL("../../../docs/merge-providers.md", import.meta.url),
      "utf8",
    );
    const statements = guide
      .split("```sql\n")[1]
      .split("\n```")[0]
      .split(";")
      .filter((statement) => statement.trim());
    const dueBefore = (
      await db.pool.query(
        "select merge_after from pull_requests where public_id=$1",
        [pr],
      )
    ).rows[0].merge_after;
    for (const sha of ["c".repeat(40), headSha]) {
      const inputs: Record<string, string> = {
        review_id: review.id,
        head_sha: sha,
        incident: "IR-23",
      };
      let returned: { public_id: string }[] = [];
      try {
        for (const statement of statements) {
          const values: string[] = [];
          const query = statement.replace(
            /:'(\w+)'/g,
            (_match, key: string) => {
              assert.ok(Object.hasOwn(inputs, key));
              values.push(inputs[key]);
              return `$${values.length}`;
            },
          );
          returned = (
            await fixture.administrator.query<{ public_id: string }>(
              query,
              values,
            )
          ).rows;
        }
        if (sha === headSha) {
          assert.deepEqual(returned, [{ public_id: pr }]);
          await fixture.administrator.query("commit");
        } else {
          assert.deepEqual(returned, []);
          await fixture.administrator.query("rollback");
          const remaining = (
            await db.pool.query(
              "select p.merge_after, r.merge_action from pull_requests p join reviews r on r.merge_pull_request_id=p.id where r.public_id=$1",
              [review.id],
            )
          ).rows[0];
          assert.deepEqual(remaining, {
            merge_after: dueBefore,
            merge_action: "uncertain",
          });
        }
      } catch (error) {
        await fixture.administrator.query("rollback");
        throw error;
      }
    }
    const audit = (
      await db.pool.query(
        "select decision,action from merge_decision_history where review_id=(select id from reviews where public_id=$1) and decision->'reasons'->0->>'code'='operator_resolved'",
        [review.id],
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "refused");
    assert.match(audit[0].decision.reasons[0].message, /postgres.*IR-23/);
  },
);
