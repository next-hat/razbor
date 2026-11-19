import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { mergePolicySchema } from "@razbor/contracts";
import {
  acceptWebhook,
  abandonGitlabPublication,
  applyWebhookSettings,
  beginAttempt,
  connectDatabase,
  finishAttempt,
  hasEligibleRunner,
  listRepositories,
  listReviews,
  pendingDispatches,
  preparePublication,
  processDeferredOpen,
  processInteraction,
  processMergeTriage,
  triageOutstanding,
  publicationView,
  listPullRequests,
  submitReview,
  syncPullRequests,
  webhookView,
} from "@razbor/database";
import { applyRegistry, registrySchema } from "@razbor/database/registry";
import { reviews } from "@razbor/database/schema";
import { createForge, ForgejoInteractions } from "@razbor/forge-adapters";

import { databaseFixture } from "@tests/packages/database/fixture.js";

/** Hold one provider response until the competing delivery commits its observed revision. */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "signed PR events persist opt-in, deduplicate revisions, and coalesce racing deliveries without a runner",
  { timeout: 90000 },
  async (t) => {
    const fixture = await databaseFixture();
    let database = connectDatabase(fixture.url);
    const secret = "a".repeat(64);
    process.env.RAZBOR_TEST_TRIGGER_SECRET = secret;
    const bot = { id: 9, login: "razbor" };
    const author = { id: 2, login: "alice" };
    let prAuthor = author;
    let privateRepo = true;
    const base = "a".repeat(40);
    let head = "b".repeat(40);
    let draft = false;
    let detailedBranches = true;
    let closed = false;
    let origin = "";
    let requestId = 0;
    let commentNumber = 7;
    let nextBotId = 1000;
    let commandTime = new Date(Date.now() + 60_000);
    const comments = new Map<
      number,
      {
        id: number;
        body: string;
        user: typeof bot;
        pull_request_url: string;
        issue_url: string;
      }
    >();
    const mutations: string[] = [];
    const observedPulls = new Set<number>();
    let observed = barrier();
    let release = barrier();
    let listDraft = true;
    let pauseRead = false;
    const concurrentDetail = barrier();
    const releaseRefresh = barrier();
    let refreshReads: number[] | undefined;
    let omitDetailDraft = false;
    let staleListing: "branch" | "head" | undefined;
    let unavailableDetail: number | undefined;
    const server = createServer(async (req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname;
      const method = req.method ?? "GET";
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      if (method !== "GET") mutations.push(method + " " + path);
      res.setHeader("Content-Type", "application/json");
      /** Serialize one local provider response. */
      const send = (data: unknown) => res.end(JSON.stringify(data));
      if (path.endsWith("/user")) return send(bot);
      if (path.endsWith("/repos/team/project"))
        return send({
          id: 1,
          full_name: "team/project",
          html_url: origin + "/team/project",
          private: privateRepo,
          archived: false,
        });
      if (path.endsWith("/hooks"))
        return send(method === "GET" ? [] : { id: 1 });
      if (path.endsWith("/reactions")) return send(method === "GET" ? [] : {});
      if (path.endsWith("/reviews")) return send([]);
      const pull = /\/pulls\/(\d+)$/.exec(path);
      /** Return the provider's current PR fields for both listing and detail reads. */
      function pullResponse(number: number, detail: boolean) {
        const stale = number === 25 && !detail ? staleListing : undefined;
        return {
          number,
          state: closed ? "closed" : "open",
          merged: false,
          draft:
            (!detail && !listDraft) ||
            (number === 25 && detail && omitDetailDraft)
              ? undefined
              : draft,
          title: "Review lifecycle",
          user: prAuthor,
          html_url: origin + "/team/project/pulls/" + number,
          base: {
            sha: base,
            ref:
              stale === "branch"
                ? "release"
                : !detail || detailedBranches
                  ? "main"
                  : undefined,
            repo_id: 1,
          },
          head: {
            sha: stale === "head" ? "e".repeat(40) : head,
            ref: !detail || detailedBranches ? "fork-feature" : undefined,
          },
          merge_base: base,
          updated_at: commandTime.toISOString(),
        };
      }
      if (path.endsWith("/pulls"))
        return send(
          new URL(req.url!, origin).searchParams.get("page") === "1"
            ? [...observedPulls].map((number) => pullResponse(number, false))
            : [],
        );
      if (pull) {
        const number = Number(pull[1]);
        if (number === unavailableDetail) {
          res.writeHead(503);
          return send({ message: "Detail unavailable" });
        }
        observedPulls.add(number);
        const response = pullResponse(number, true);
        if (pauseRead) {
          pauseRead = false;
          observed.resolve();
          await release.promise;
        }
        if (refreshReads) {
          refreshReads.push(number);
          if (refreshReads.length === 1) await releaseRefresh.promise;
          else concurrentDetail.resolve();
        }
        return send(response);
      }
      const list = /\/issues\/(\d+)\/comments$/.exec(path);
      if (list) {
        const url = origin + "/api/v1/repos/team/project/pulls/" + list[1];
        if (method === "GET")
          return send(
            [...comments.values()].filter((c) => c.pull_request_url === url),
          );
        const comment = {
          id: nextBotId++,
          user: bot,
          body: body.body,
          pull_request_url: url,
          issue_url: "",
        };
        comments.set(comment.id, comment);
        return send(comment);
      }
      const item = /\/issues\/comments\/(\d+)$/.exec(path);
      if (item) {
        const id = Number(item[1]),
          saved = comments.get(id);
        if (saved) {
          if (method === "PATCH") saved.body = body.body;
          if (method === "DELETE") comments.delete(id);
          return send(saved);
        }
        return send({
          id,
          body: "/agentic_review",
          user: author,
          created_at: commandTime.toISOString(),
          pull_request_url:
            origin + "/api/v1/repos/team/project/pulls/" + commentNumber,
          issue_url: "",
        });
      }
      res.statusCode = 404;
      return send({});
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      origin = "http://127.0.0.1:" + address.port;
      const config = registrySchema.parse({
        registry: { key: "test" },
        forges: {
          forge: {
            type: "forgejo",
            api_url: origin + "/api/v1",
            web_url: origin,
            allow_http: true,
          },
        },
        repositories: {
          project: {
            forge: "forge",
            selector: "team/project",
            indexing: { owner: "test", persistent: false },
            git: {
              branch: "main",
              upstream: "refs/remotes/origin/main",
              remotes: { origin: "https://example.com/team/project.git" },
            },
            webhook: {
              enabled: true,
              callback_base: "https://hooks.example.com",
              secret: { env: "RAZBOR_TEST_TRIGGER_SECRET" },
              permitted_senders: ["alice"],
            },
          },
        },
      });
      await applyRegistry(database, config);
      await applyWebhookSettings(database, config);
      const [repo] = await listRepositories(database);
      const hook = await webhookView(database, repo.id);
      assert.ok(hook);
      const hookId = hook.id;
      /** Send a signed, uniquely identified event to the normal repository ingress. */
      function deliver(
        payload: object,
        kind: string,
        id = String(++requestId),
      ) {
        const raw = Buffer.from(JSON.stringify(payload));
        return acceptWebhook(database, hookId, raw, {
          "x-forgejo-delivery": id,
          "x-forgejo-event": kind,
          "x-forgejo-signature": createHmac("sha256", secret)
            .update(raw)
            .digest("hex"),
        });
      }
      /** Emit a PR event, independent of the authoritative revision returned by the test forge. */
      function lifecycle(action: string, number = 7, id?: string) {
        return deliver(
          {
            action,
            repository: { id: 1 },
            pull_request: {
              number,
              user: author,
              draft,
              updated_at: new Date(commandTime.getTime() + 1000).toISOString(),
            },
            changes: { title: { from: "WIP: Review lifecycle" } },
          },
          "pull_request",
          id,
        );
      }
      /** Deliver a review command whose author and PR are checked again by the provider adapter. */
      function command(id: number, sender = author, number = 7) {
        commentNumber = number;
        return deliver(
          {
            action: "created",
            is_pull: true,
            issue: { number },
            repository: { id: 1 },
            sender,
            comment: { id, user: sender, body: "/agentic_review" },
          },
          "issue_comment",
        );
      }
      /** Return only code-review runs for the test repository. */
      function history() {
        return listReviews(database, repo.id);
      }

      assert.equal(await lifecycle("opened"), 200);
      assert.equal(await lifecycle("synchronized"), 200);
      assert.equal((await history()).length, 0);
      assert.equal(await command(1), 202);
      assert.equal((await history()).length, 1);

      config.repositories.project.reviewTriggerMode = "opt_in_continuous";
      await applyRegistry(database, config);
      assert.equal(await lifecycle("synchronized"), 200);
      assert.equal(await command(2, { id: 3, login: "stranger" }), 403);
      assert.equal((await history()).length, 1);
      assert.equal(await command(3), 202);
      assert.equal((await history()).length, 2);
      const prior = database;
      database = connectDatabase(fixture.url);
      await prior.close();
      head = "c".repeat(40);
      await lifecycle("synchronized", 8);
      assert.equal((await history()).length, 2);
      assert.equal(await lifecycle("synchronized", 7, "after-restart"), 202);
      assert.equal(await lifecycle("synchronized", 7, "after-restart"), 202);
      await lifecycle("synchronized");
      assert.equal((await history()).length, 3);
      const [active] = await history();
      assert.equal(await hasEligibleRunner(database, active.id), false);
      assert.ok(
        (await pendingDispatches(database)).some(
          (job) => job.reviewId === active.id,
        ),
      );
      assert.equal((await pendingDispatches(database, true)).length, 0);
      const attempt = await beginAttempt(database, active.id, "fixture", 30000);
      assert.equal(attempt.kind, "started");
      if (attempt.kind !== "started")
        throw new Error("fixture attempt unavailable");
      assert.ok(
        attempt.source.git.extra_fetch_refs.origin.includes("refs/pull/7/head"),
      );
      // Let one webhook capture D but keep its response in flight while E commits to the DB.
      head = "d".repeat(40);
      pauseRead = true;
      const earlier = lifecycle("synchronized");
      await Promise.race([
        observed.promise,
        earlier.then((status) => {
          throw new Error(
            `Delivery returned HTTP ${status} before reading the PR`,
          );
        }),
      ]);
      head = "e".repeat(40);
      assert.equal(await lifecycle("synchronized"), 202);
      release.resolve();
      assert.equal(await earlier, 202);
      assert.equal((await history())[0].headSha, head);
      head = "f".repeat(40);
      assert.equal(await lifecycle("synchronized"), 202);
      const runs = await history();
      assert.equal(runs.length, 4);
      const [pending] = runs;
      assert.equal(pending.headSha, head);
      assert.ok(
        !(await pendingDispatches(database)).some(
          (job) => job.reviewId === pending.id,
        ),
      );
      assert.equal(
        (await beginAttempt(database, pending.id, "second", 30000)).kind,
        "busy",
      );
      await finishAttempt(database, active.id, attempt.attemptId, "fixture", {
        summary: "Historical result",
        findings: [],
      });
      assert.ok(
        (await pendingDispatches(database)).some(
          (job) => job.reviewId === pending.id,
        ),
      );
      assert.equal(
        (await history()).find((job) => job.id === active.id)?.headSha,
        "c".repeat(40),
      );

      closed = true;
      await lifecycle("closed");
      const retired = (await history()).find((job) => job.id === pending.id);
      assert.equal(retired?.status, "failed");
      closed = false;
      await lifecycle("reopened");
      await lifecycle("synchronized");
      assert.equal((await history()).length, 4);
      commandTime = new Date(commandTime.getTime() + 10000);
      await command(4);
      assert.equal((await history()).length, 5);
      await lifecycle("opened", 12);

      config.repositories.project.reviewTriggerMode = "automatic";
      config.repositories.project.codebaseMemoryEnabled = false;
      await applyRegistry(database, config);
      // A rename on an already-ready PR observed before the mode switch is metadata only.
      await lifecycle("edited", 12);
      assert.equal((await history()).length, 5);
      draft = true;
      await lifecycle("opened", 9);
      assert.equal((await history()).length, 5);
      draft = false;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.equal((await history()).length, 5);
      await lifecycle("edited", 9);
      assert.equal((await history()).length, 6);
      await lifecycle("synchronized", 9);
      assert.equal((await history()).length, 6);
      head = "1".repeat(40);
      await lifecycle("opened", 10);
      assert.equal((await history()).length, 7);
      await command(5, author, 10);
      assert.equal((await history()).length, 8);
      draft = true;
      await lifecycle("opened", 11);
      const saved = (await listPullRequests(database, [repo.id])).find(
        (item) => item.number === 11,
      );
      assert.ok(saved);
      await submitReview(
        database,
        { repositoryId: repo.id, baseSha: base, headSha: head },
        undefined,
        undefined,
        saved.id,
      );
      draft = false;
      await lifecycle("edited", 11);
      assert.equal((await history()).length, 9);
      head = "2".repeat(40);
      await lifecycle("synchronized", 10);
      const retrying = (await history()).find((run) => run.headSha === head);
      assert.ok(retrying);
      const retryAttempt = await beginAttempt(
        database,
        retrying.id,
        "retry",
        30000,
      );
      if (retryAttempt.kind !== "started")
        throw new Error("expected automatic attempt");
      head = "3".repeat(40);
      await lifecycle("synchronized", 10);
      await finishAttempt(
        database,
        retrying.id,
        retryAttempt.attemptId,
        "retry",
        undefined,
      );
      assert.equal(
        (await history()).find((run) => run.id === retrying.id)?.status,
        "failed",
      );
      assert.ok(
        (await pendingDispatches(database)).some((job) => job.headSha === head),
      );
      const [waitingRetry] = (await history()).filter(
        (run) => run.headSha === head,
      );
      const oldAttempt = await beginAttempt(
        database,
        waitingRetry.id,
        "old-assignment",
        30000,
      );
      if (oldAttempt.kind !== "started")
        throw new Error("expected first attempt on latest head");
      await finishAttempt(
        database,
        waitingRetry.id,
        oldAttempt.attemptId,
        "old-assignment",
        undefined,
      );
      assert.equal(
        (await history()).find((run) => run.id === waitingRetry.id)?.status,
        "queued",
      );
      head = "4".repeat(40);
      await lifecycle("synchronized", 10);
      assert.equal(
        (await history()).find((run) => run.id === waitingRetry.id)?.status,
        "failed",
      );
      assert.ok(
        (await pendingDispatches(database)).some((job) => job.headSha === head),
      );
      for (const [number, indexed] of [
        [20, false],
        [21, true],
      ] as const) {
        config.repositories.project.codebaseMemoryEnabled = indexed;
        await applyRegistry(database, config);
        const count = (await history()).length;
        await lifecycle("opened", number);
        await lifecycle("synchronized", number);
        assert.equal((await history()).length, count + 1);
      }
      assert.ok(!mutations.some((route) => /\/merge(?:$|\/)/.test(route)));
      const priorCount = (await history()).length;
      await lifecycle("edited", 22);
      assert.equal((await history()).length, priorCount + 1);
      // A listing can catch a draft transition before the webhook arrives. A later
      // ready event must still start exactly one review in fully automatic mode.
      draft = true;
      await lifecycle("opened", 23);
      /** Read the draft evidence and admission generation of the tracked PR. */
      const draftFence = async () =>
        (
          await database.pool.query(
            "select draft, trigger_generation from pull_requests where number=23",
          )
        ).rows[0];
      const beforeReady = await draftFence();
      assert.equal(beforeReady.draft, true);
      draft = false;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.deepEqual(await draftFence(), beforeReady);
      await lifecycle("edited", 23);
      assert.equal((await history()).length, priorCount + 2);
      /** Read both fences, branch names, and SHAs for this provider PR. */
      async function savedBranches() {
        return (
          await database.pool.query(
            "select head_branch,base_branch,head_sha,base_sha,trigger_generation,merge_revision from pull_requests where number=23",
          )
        ).rows[0];
      }
      const originalBranches = await savedBranches();
      detailedBranches = false;
      await lifecycle("synchronized", 23);
      assert.deepEqual(await savedBranches(), originalBranches);
      const openChanges = ForgejoInteractions.prototype.openChanges;
      let listedBase: string | undefined;
      const partialListing = t.mock.method(
        ForgejoInteractions.prototype,
        "openChanges",
        async function (this: ForgejoInteractions) {
          return (await openChanges.call(this)).map((p) => ({
            ...p,
            headBranch: undefined,
            baseBranch: p.number === 23 ? listedBase : undefined,
          }));
        },
      );
      try {
        assert.deepEqual(
          (await syncPullRequests(database, [repo.id])).failures,
          [],
        );
        assert.deepEqual(await savedBranches(), originalBranches);
        // Both branches point at the same commit. Only the listing reports the retarget.
        listedBase = "release";
        assert.deepEqual(
          (await syncPullRequests(database, [repo.id])).failures,
          [],
        );
        assert.deepEqual(await savedBranches(), {
          ...originalBranches,
          base_branch: listedBase,
          trigger_generation: originalBranches.trigger_generation + 1,
          merge_revision: originalBranches.merge_revision + 1,
        });
      } finally {
        partialListing.mock.restore();
      }
      detailedBranches = true;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.deepEqual(await savedBranches(), {
        ...originalBranches,
        trigger_generation: originalBranches.trigger_generation + 2,
        merge_revision: originalBranches.merge_revision + 2,
      });
      await lifecycle("edited", 23);
      assert.equal((await history()).length, priorCount + 2);
      observed = barrier();
      release = barrier();
      pauseRead = true;
      const beforeDraftRefresh = lifecycle("synchronized", 23);
      await Promise.race([
        observed.promise,
        beforeDraftRefresh.then((status) => {
          throw new Error(
            `Delivery returned HTTP ${status} before reading the PR`,
          );
        }),
      ]);
      draft = true;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      const refreshed = (await listPullRequests(database, [repo.id])).find(
        (pr) => pr.number === 23,
      );
      assert.equal(refreshed?.merge?.decision.status, "stale");
      assert.equal(refreshed?.merge?.confidence, undefined);
      release.resolve();
      await beforeDraftRefresh;
      listDraft = false;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      const draftAfterRefresh = await database.pool.query(
        "select draft from pull_requests where number=23",
      );
      assert.equal(
        draftAfterRefresh.rows[0].draft,
        true,
        "an older webhook or a listing without draft information must not restore readiness",
      );
      listDraft = true;
      draft = false;
      // A completed automatic result may already have had its ready transition
      // refreshed. The signed edit replaces the stale merge review just once.
      config.repositories.project.mergePolicy = mergePolicySchema.parse({
        enabled: true,
      });
      await applyRegistry(database, config);
      await lifecycle("opened", 27);
      const [priorReadyReview] = await history();
      const readyAttempt = await beginAttempt(
        database,
        priorReadyReview.id,
        "fixture",
        30000,
      );
      assert.equal(readyAttempt.kind, "started");
      await finishAttempt(
        database,
        priorReadyReview.id,
        readyAttempt.attemptId,
        "fixture",
        {
          summary: "Completed the prior ready revision",
          findings: [],
        },
      );
      draft = true;
      await lifecycle("edited", 27);
      draft = false;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      const beforeReadyWebhook = (await history()).length;
      const refreshedRevision = (
        await database.pool.query(
          "select draft, merge_revision from pull_requests where number=27",
        )
      ).rows[0];
      assert.equal(refreshedRevision.draft, false);
      assert.notEqual(
        readyAttempt.source.mergeRevision,
        refreshedRevision.merge_revision,
      );
      assert.equal(await lifecycle("edited", 27), 202);
      assert.equal((await history()).length, beforeReadyWebhook + 1);
      const [replacementReadyReview] = await history();
      const captured = (
        await database.pool.query(
          "select (source->>'mergeRevision')::int as revision from reviews where public_id=$1",
          [replacementReadyReview.id],
        )
      ).rows[0];
      assert.equal(captured.revision, refreshedRevision.merge_revision);
      await lifecycle("edited", 27);
      assert.equal((await history()).length, beforeReadyWebhook + 1);
      delete config.repositories.project.mergePolicy;
      await applyRegistry(database, config);
      head = "6".repeat(40);
      await lifecycle("opened", 124);
      const [oldAutomatic] = await history();
      await command(301, author, 124);
      const [oldAuthority] = await history();
      const olderAttempt = await beginAttempt(
        database,
        oldAuthority.id,
        "fixture",
        30000,
      );
      assert.equal(olderAttempt.kind, "started");
      await finishAttempt(
        database,
        oldAuthority.id,
        olderAttempt.attemptId,
        "fixture",
        {
          summary: "Prior review",
          findings: [],
        },
      );
      await database.pool.query(
        "update reviews set merge_action='uncertain' where public_id=$1",
        [oldAuthority.id],
      );
      head = "7".repeat(40);
      assert.equal(await lifecycle("synchronized", 124, "replacement"), 202);
      assert.equal(await lifecycle("synchronized", 124, "replacement"), 202);
      const afterPush = await history();
      assert.equal(afterPush[0].headSha, head);
      assert.notEqual(afterPush[0].id, oldAutomatic.id);
      assert.equal(
        afterPush.find((r) => r.id === oldAutomatic.id)?.status,
        "failed",
      );
      assert.equal(await command(302, author, 124), 202);
      assert.equal(await command(302, author, 124), 202);
      const afterCommand = await history();
      assert.equal(afterCommand.length, afterPush.length + 1);
      assert.equal(afterCommand[0].headSha, head);
      for (const unavailable of [true, false]) {
        unavailableDetail = unavailable ? 124 : undefined;
        await database.pool.query(
          "update pull_requests set merge_after=timestamp '2000-01-01' where number=124",
        );
        await processMergeTriage(database);
        const stored = await database.pool.query(
          "select merge_action, merge_decision->'reasons'->0->>'code' as reason from reviews where public_id=$1",
          [afterCommand[0].id],
        );
        assert.deepEqual(stored.rows[0], {
          merge_action: null,
          reason: "prior_write_uncertain",
        });
      }
      assert.equal(
        (
          await database.pool.query(
            "select merge_action from reviews where public_id=$1",
            [oldAuthority.id],
          )
        ).rows[0].merge_action,
        "uncertain",
      );
      const { rows } = await database.pool.query(
        "select origin, comment_id from review_triggers",
      );
      await lifecycle("opened", 125);
      const [oldSuccess] = await history();
      const good = await beginAttempt(
        database,
        oldSuccess.id,
        "fixture",
        30000,
      );
      assert.equal(good.kind, "started");
      await finishAttempt(database, oldSuccess.id, good.attemptId, "fixture", {
        summary: "Clean",
        findings: [],
      });
      assert.equal(await command(303, author, 125), 202);
      const [manualFailure] = await history();
      const failed = await beginAttempt(
        database,
        manualFailure.id,
        "fixture",
        30000,
      );
      assert.equal(failed.kind, "started");
      await finishAttempt(
        database,
        manualFailure.id,
        failed.attemptId,
        "fixture",
        undefined,
        true,
      );
      assert.equal(await lifecycle("synchronized", 125), 202);
      const [retry] = await history();
      assert.notEqual(retry.id, manualFailure.id);
      assert.notEqual(retry.id, oldSuccess.id);
      assert.equal(retry.status, "queued");
      assert.ok(
        rows
          .filter((row) => row.origin === "automatic")
          .every((row) => row.comment_id === null),
      );
      assert.ok(
        rows
          .filter((row) => row.origin === "manual")
          .every((row) => row.comment_id !== null),
      );
      const beforeFork = (await history()).length;
      privateRepo = false;
      // The signed event still names Alice. Only the live PR author's login can authorize an automatic public review.
      prAuthor = { id: 8, login: "contributor" };
      await lifecycle("opened", 23);
      await lifecycle("synchronized", 23);
      assert.equal((await history()).length, beforeFork);
      assert.equal(await command(23, author, 23), 202);
      assert.equal((await history()).length, beforeFork + 1);
      prAuthor = { ...author, login: "ALICE" };
      await lifecycle("opened", 24);
      assert.equal((await history()).length, beforeFork + 2);
      // Refresh may recover readiness for a completed automatic run on this revision.
      const [reviewed] = await history();
      const run = await beginAttempt(database, reviewed.id, "fixture", 30000);
      assert.ok(run.kind === "started");
      await finishAttempt(database, reviewed.id, run.attemptId, "fixture", {
        summary: "Review complete",
        findings: [],
      });
      config.repositories.project.webhook!.permitted_senders = ["*"];
      await applyWebhookSettings(database, config);
      await lifecycle("opened", 25);
      assert.equal((await history()).length, beforeFork + 2);
      privateRepo = true;
      await lifecycle("synchronized", 25);
      assert.equal((await history()).length, beforeFork + 3);

      // A slow detail must allow another PR to progress. A racing webhook
      // invalidates the observed row version and requires a fresh detail.
      refreshReads = [];
      omitDetailDraft = true;
      const refresh = syncPullRequests(database, [repo.id]);
      try {
        await Promise.race([
          concurrentDetail.promise,
          refresh.then(({ failures }) => {
            throw new Error(
              `Refresh finished before details overlapped: ${failures}`,
            );
          }),
        ]);
        draft = true;
        await lifecycle("edited", 24);
        draft = false;
      } finally {
        releaseRefresh.resolve();
      }
      assert.deepEqual((await refresh).failures, []);
      assert.equal(refreshReads.filter((number) => number === 24).length, 3);
      refreshReads = undefined;
      /** Read readiness directly to distinguish a confirmed ready PR from an unknown state. */
      const savedDraft = async (number: number) =>
        (
          await database.pool.query(
            "select draft from pull_requests where number = $1",
            [number],
          )
        ).rows[0].draft;
      assert.equal(await savedDraft(24), false);
      assert.equal(await savedDraft(25), false);
      // A same-SHA retarget cannot borrow draft readiness from the previous destination.
      staleListing = "branch";
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.equal(await savedDraft(25), null);
      staleListing = undefined;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.equal(await savedDraft(25), false);
      staleListing = "head";
      observedPulls.add(26);
      unavailableDetail = 24;
      assert.deepEqual((await syncPullRequests(database, [repo.id])).failures, [
        repo.id,
      ]);
      assert.equal(await savedDraft(25), false);
      assert.ok(
        !(await listPullRequests(database, [repo.id])).some(
          (item) => item.number === 26,
        ),
      );
      unavailableDetail = undefined;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.equal(await savedDraft(25), null);
      assert.ok(
        (await listPullRequests(database, [repo.id])).some(
          (item) => item.number === 26,
        ),
      );
    } finally {
      release.resolve();
      delete process.env.RAZBOR_TEST_TRIGGER_SECRET;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      await fixture.close();
    }
  },
);

test(
  "GitLab automatic review fetches a fork MR from the target remote and pins its complete merge-base diff",
  { timeout: 60000 },
  async () => {
    const fixture = await databaseFixture();
    const secret = "b".repeat(64);
    process.env.RAZBOR_TEST_MR_SECRET = secret;
    const target = "2".repeat(40),
      head = "3".repeat(40);
    let base = "1".repeat(40);
    let start = target;
    let iid = 27;
    let diffReady = false;
    let detailResponse: "valid" | "foreign" | "unavailable" = "valid";
    let providerRequests = 0;
    const foreignRead = barrier();
    const releaseForeign = barrier();
    let draft = false;
    let closed = false;
    let draftNote: { id: number; author_id: number; note: string } | undefined;
    const closedCommandRead = barrier();
    const releaseClosedCommand = barrier();
    const postReopenTime = "2026-01-02T00:00:00.000Z";
    let summaryNote:
      | {
          id: number;
          body: string;
          author: { id: number; username: string };
          created_at: string;
        }
      | undefined;
    let bulkRequests = 0;
    const discussions: unknown[] = [];
    const diff =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+changed\n";
    let hideDeletion = true;
    let hookUrl: string | undefined;
    let origin = "";
    const server = createServer(async (req, res) => {
      providerRequests++;
      const path = decodeURIComponent(
        new URL(req.url!, "http://localhost").pathname,
      );
      res.setHeader("Content-Type", "application/json");
      /** Return a GitLab project or MR response on the target project's routes. */
      const send = (body: unknown) => res.end(JSON.stringify(body));
      if (path.endsWith("/user")) return send({ id: 9, username: "razbor" });
      if (path.endsWith("/projects/team/project"))
        return send({
          id: 1,
          path_with_namespace: "team/project",
          web_url: origin + "/team/project",
          archived: false,
          visibility: "private",
        });
      if (path.endsWith("/hooks") || path.endsWith("/hooks/1"))
        return send(
          req.method === "GET"
            ? hookUrl
              ? [{ id: 1, url: hookUrl }]
              : []
            : { id: 1 },
        );
      if (
        path.endsWith("/merge_requests/" + iid) ||
        path.endsWith("/merge_requests")
      ) {
        const mr = {
          iid,
          project_id: 1,
          source_project_id: 2,
          target_project_id: 1,
          sha: head,
          state: closed ? "closed" : "opened",
          draft,
          title: "Fork MR",
          author: { id: 2, username: "alice" },
          web_url: origin + "/team/project/-/merge_requests/" + iid,
          target_branch: "main",
          source_branch: "fork-branch",
          updated_at: "2026-01-01T00:00:00Z",
        };
        if (path.endsWith("/merge_requests"))
          return send(
            !closed &&
              new URL(req.url!, origin).searchParams.get("page") === "1"
              ? [mr]
              : [],
          );
        if (detailResponse === "unavailable") {
          res.writeHead(503);
          return send({ message: "Temporarily unavailable" });
        }
        const webUrl =
          detailResponse === "foreign"
            ? origin + "/other/project/-/merge_requests/" + iid
            : mr.web_url;
        if (detailResponse === "foreign") {
          foreignRead.resolve();
          await releaseForeign.promise;
        }
        return send({
          ...mr,
          web_url: webUrl,
          diff_refs: diffReady
            ? { start_sha: start, base_sha: base, head_sha: head }
            : {},
        });
      }
      if (path.endsWith("/repository/branches/main"))
        return send({ name: "main", commit: { id: target } });
      if (path.endsWith("/draft_notes"))
        return send(draftNote ? [draftNote] : []);
      if (path.endsWith("/draft_notes/41") && req.method === "DELETE") {
        if (!hideDeletion) draftNote = undefined;
        res.statusCode = 404;
        return send({});
      }
      if (path.endsWith("/draft_notes/bulk_publish")) {
        bulkRequests++;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        summaryNote = {
          id: 53,
          body: JSON.parse(Buffer.concat(chunks).toString()).note,
          author: { id: 9, username: "razbor" },
          created_at: "2026-01-02T00:00:00Z",
        };
        return send({});
      }
      if (path.endsWith("/approvals")) return send({ user_can_approve: true });
      if (path.endsWith("/reviewers"))
        return send([
          { user: { id: 9, username: "razbor" }, state: "requested_changes" },
        ]);
      if (path.endsWith("/discussions")) return send(discussions);
      if (path.endsWith("/raw_diffs")) return res.end(diff);
      if (
        summaryNote &&
        path.endsWith("/notes/" + summaryNote.id) &&
        req.method === "PUT"
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        summaryNote.body = JSON.parse(Buffer.concat(chunks).toString()).body;
        return send(summaryNote);
      }
      if (path.endsWith("/notes"))
        return send(
          req.method === "GET"
            ? summaryNote &&
              Number(new URL(req.url!, origin).searchParams.get("page")) <= 1
              ? [summaryNote]
              : []
            : { id: 51 },
        );
      const commandNote = /\/notes\/(92|93|94)$/.exec(path);
      if (commandNote) {
        const id = Number(commandNote[1]);
        if (id === 93) {
          closedCommandRead.resolve();
          await releaseClosedCommand.promise;
        }
        return send({
          id,
          body: "/agentic_review",
          author: { id: 2, username: "alice" },
          created_at: id === 94 ? postReopenTime : "2025-01-01T00:00:00Z",
        });
      }
      res.statusCode = 404;
      return send({});
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      origin = "http://127.0.0.1:" + address.port;
      const config = registrySchema.parse({
        registry: { key: "test" },
        forges: {
          lab: {
            type: "gitlab",
            api_url: origin + "/api/v4",
            web_url: origin,
            allow_http: true,
          },
        },
        repositories: {
          project: {
            forge: "lab",
            selector: "team/project",
            reviewTriggerMode: "automatic",
            indexing: { owner: "test", persistent: false },
            git: {
              branch: "main",
              upstream: "refs/remotes/target/main",
              remotes: { target: "https://example.com/team/project.git" },
            },
            webhook: {
              enabled: true,
              callback_base: "https://hooks.example.com",
              secret: { env: "RAZBOR_TEST_MR_SECRET" },
              permitted_senders: ["alice"],
            },
          },
        },
      });
      const { database } = fixture;
      await applyRegistry(database, config);
      await applyWebhookSettings(database, config);
      const [repo] = await listRepositories(database);
      const hook = await webhookView(database, repo.id);
      assert.ok(hook);
      hookUrl = hook.callbackUrl;
      const payload = {
        object_kind: "merge_request",
        project: { id: 1 },
        user: { id: 2, username: "alice" },
        object_attributes: {
          action: "update",
          iid: 27,
          author_id: 2,
          target_project_id: 1,
          source_project_id: 2,
          oldrev: "0".repeat(40),
        },
      };
      const event = Buffer.from(JSON.stringify(payload));
      const opening = Buffer.from(
        JSON.stringify({
          ...payload,
          object_attributes: { ...payload.object_attributes, action: "open" },
        }),
      );
      /** Deliver the signed opening with its independent GitLab delivery identity. */
      const open = (deliveryId: string) =>
        acceptWebhook(database, hook.id, opening, {
          "x-gitlab-token": secret,
          "x-gitlab-event": "Merge Request Hook",
          "webhook-id": deliveryId,
        });
      /** Read the durable dispatcher state for one authenticated delivery. */
      const receiptFor = async (deliveryId: string) =>
        (
          await database.pool.query(
            "select pending_open, open_retry_after from webhook_deliveries where delivery_id = $1",
            [deliveryId],
          )
        ).rows[0];
      /** Make an existing retry immediately eligible without changing its pending event. */
      const retryNow = (deliveryId: string) =>
        database.pool.query(
          "update webhook_deliveries set open_retry_after = now() where delivery_id = $1 and pending_open is not null returning open_retry_after",
          [deliveryId],
        );
      assert.equal(await open("mr-foreign"), 202);
      diffReady = true;
      detailResponse = "foreign";
      const olderWorker = processDeferredOpen(database);
      try {
        await Promise.race([
          foreignRead.promise,
          olderWorker.then(() => {
            throw new Error(
              "Dispatcher returned before reading the deferred MR",
            );
          }),
        ]);
        // A later claim sees a pending diff while the older foreign response is still in flight.
        await retryNow("mr-foreign");
        detailResponse = "valid";
        diffReady = false;
        await processDeferredOpen(database);
      } finally {
        releaseForeign.resolve();
        await olderWorker;
      }
      const currentClaim = await receiptFor("mr-foreign");
      assert.ok(currentClaim.pending_open);
      assert.ok(currentClaim.open_retry_after instanceof Date);
      diffReady = true;
      detailResponse = "foreign";
      await retryNow("mr-foreign");
      await processDeferredOpen(database);
      assert.deepEqual(await receiptFor("mr-foreign"), {
        pending_open: null,
        open_retry_after: null,
      });
      const requestsAfterRejection = providerRequests;
      await retryNow("mr-foreign");
      await processDeferredOpen(database);
      assert.equal(providerRequests, requestsAfterRejection);
      assert.equal((await listReviews(database)).length, 0);

      detailResponse = "valid";
      assert.equal(await open("mr-foreign"), 202);
      assert.equal((await listReviews(database)).length, 0);
      diffReady = false;
      assert.equal(await open("mr-open"), 202);
      await processDeferredOpen(database);
      assert.equal((await listReviews(database)).length, 0);
      const restarted = connectDatabase(fixture.url);
      try {
        // Reapply identical webhook settings and confirm that the owned hook is still ready.
        await applyWebhookSettings(restarted, config);
        assert.equal((await webhookView(restarted, repo.id))?.setup, "ready");
        const {
          rows: [due],
        } = await retryNow("mr-open");
        diffReady = true;
        detailResponse = "unavailable";
        await assert.rejects(processDeferredOpen(restarted), {
          reason: "unavailable",
          status: 503,
        });
        const retry = await receiptFor("mr-open");
        assert.ok(retry.pending_open);
        assert.ok(
          retry.open_retry_after instanceof Date &&
            retry.open_retry_after > due.open_retry_after,
        );
        assert.equal((await listReviews(restarted)).length, 0);
        detailResponse = "valid";
        await retryNow("mr-open");
        await processDeferredOpen(restarted);
        assert.equal((await listReviews(restarted)).length, 1);
      } finally {
        await restarted.close();
      }
      assert.equal(
        await acceptWebhook(database, hook.id, event, {
          "x-gitlab-token": secret,
          "x-gitlab-event": "Merge Request Hook",
          "webhook-id": "mr-latest",
        }),
        202,
      );
      const [review] = await listReviews(database);
      const reservation = await beginAttempt(
        database,
        review.id,
        "fixture",
        30000,
      );
      if (reservation.kind !== "started")
        throw new Error("MR admission did not create an executable job");
      assert.deepEqual(reservation.source.git.extra_fetch_refs.target, [
        "refs/merge-requests/27/head",
      ]);
      assert.deepEqual(reservation.source.git.remotes, {
        target: "https://example.com/team/project.git",
      });
      assert.equal(reservation.job.baseSha, base);
      assert.equal(reservation.job.headSha, head);
      const [saved] = await listPullRequests(database, [repo.id]);
      assert.equal(saved.baseSha, target);
      start = "4".repeat(40);
      diffReady = false;
      /** Deliver one signed lifecycle observation for this MR and diff version. */
      function deliver(
        id: string,
        action: string,
        ready = false,
        occurredAt?: string,
      ) {
        return acceptWebhook(
          database,
          hook!.id,
          Buffer.from(
            JSON.stringify({
              ...payload,
              object_attributes: {
                ...payload.object_attributes,
                iid,
                action,
                oldrev: ready ? undefined : payload.object_attributes.oldrev,
                actioned_at: occurredAt,
              },
              ...(ready && {
                changes: { draft: { previous: true, current: false } },
              }),
            }),
          ),
          {
            "x-gitlab-token": secret,
            "x-gitlab-event": "Merge Request Hook",
            "webhook-id": id,
          },
        );
      }
      assert.equal(await deliver("mr-new-diff", "update"), 202);
      assert.equal((await listReviews(database)).length, 1);
      diffReady = true;
      await processDeferredOpen(database);
      assert.equal((await listReviews(database)).length, 2);
      // Disabling and re-enabling the hook revokes a deferred delivery even if
      // the dispatcher is offline for both transitions.
      start = "5".repeat(40);
      diffReady = false;
      assert.equal(
        await acceptWebhook(database, hook.id, opening, {
          "x-gitlab-token": secret,
          "x-gitlab-event": "Merge Request Hook",
          "webhook-id": "mr-revoked",
        }),
        202,
      );
      config.repositories.project.webhook!.enabled = false;
      await applyWebhookSettings(database, config);
      config.repositories.project.webhook!.enabled = true;
      await applyWebhookSettings(database, config);
      diffReady = true;
      await processDeferredOpen(database);
      const {
        rows: [revoked],
      } = await database.pool.query(
        "select pending_open from webhook_deliveries where delivery_id = 'mr-revoked'",
      );
      assert.equal(revoked.pending_open, null);
      const {
        rows: [unchanged],
      } = await database.pool.query(
        "select start_sha from pull_requests where number = 27",
      );
      assert.equal(unchanged.start_sha, "4".repeat(40));
      // Resume a closed MR after a draft creation lost its response, before any native submission.
      const anchored = {
        severity: "high" as const,
        path: "file.ts",
        lineStart: 1,
        lineEnd: 1,
        title: "Missing retry",
        body: "The request can be dropped.",
        failureScenario: "A network timeout loses the request.",
        suggestion: "Retry a failed request.",
      };
      const unanchored = {
        ...anchored,
        path: "other.ts",
        title: "Missing timeout",
        failureScenario: "A stalled request blocks shutdown.",
      };
      const result = {
        summary: "Saved result",
        findings: [anchored, unanchored],
      };
      const [inline] = preparePublication(result, diff, review.id).comments;
      assert.ok(inline);
      await finishAttempt(
        database,
        review.id,
        reservation.attemptId,
        "fixture",
        result,
      );
      await database.pool.query(
        "update dispatch_outbox set acknowledged_at = now(), publication = $1::jsonb where review_id = (select id from reviews where public_id = $2)",
        [
          JSON.stringify({
            state: "failed",
            mode: "review",
            reviewPayload: {
              body: "Saved result",
              comments: [],
              event: "COMMENT",
            },
            providerProgress: { "draft-0": { writing: true } },
          }),
          review.id,
        ],
      );
      closed = true;
      draftNote = {
        id: 41,
        author_id: 9,
        note: `Finding\n\n<!-- razbor-gitlab-draft:${review.id}:0:${head} -->`,
      };
      await processInteraction(database, review.id);
      const blocked = (await publicationView(database, review.id))?.publication;
      assert.equal(blocked?.state, "failed");
      assert.deepEqual(blocked?.providerProgress?.["draft-0"], { id: "41" });
      draftNote.author_id = 8;
      hideDeletion = false;
      await processInteraction(database, review.id);
      assert.equal(
        (await publicationView(database, review.id))?.publication?.state,
        "failed",
      );
      assert.ok(draftNote);
      draftNote.author_id = 9;
      await processInteraction(database, review.id);
      assert.equal(draftNote, undefined);
      const stale = (await publicationView(database, review.id))?.publication;
      assert.equal(stale?.state, "stale");
      assert.equal(stale?.mode, undefined);
      assert.equal(stale?.providerProgress, undefined);
      assert.equal(stale?.reviewPayload, undefined);
      closed = false;
      start = target;
      await acceptWebhook(database, hook.id, event, {
        "x-gitlab-token": secret,
        "x-gitlab-event": "Merge Request Hook",
        "webhook-id": "mr-restore-after-draft-cleanup",
      });
      const restored = (await publicationView(database, review.id))
        ?.publication;
      assert.equal(restored?.state, "pending");
      assert.equal(restored?.rearmed, true);
      // A lost native response can establish the submitted notes without proving the original verdict.
      const marker = `<!-- razbor:${review.id}:result -->`;
      const summary = `Saved result: ${unanchored.title}\n\n<!-- razbor:${review.id}:recap -->`;
      summaryNote = {
        id: 52,
        author: { id: 9, username: "razbor" },
        created_at: "2026-01-01T00:00:00Z",
        body: `${marker}\n\n<!-- razbor-gitlab:${review.id}:${head}:REQUEST_CHANGES:pending -->`,
      };
      const submittedNote = {
        ...summaryNote,
        id: 61,
        body: `${inline.body}\n\n<!-- razbor-gitlab-draft:${review.id}:0:${head} -->`,
        resolved: false,
        position: {
          new_path: inline.path,
          old_path: inline.path,
          new_line: inline.lineEnd,
          head_sha: head,
          base_sha: base,
          start_sha: target,
        },
      };
      discussions.push({ id: "thread-61", notes: [submittedNote] });
      await database.pool.query(
        "update dispatch_outbox set publication = $1::jsonb where review_id = (select id from reviews where public_id = $2)",
        [
          JSON.stringify({
            state: "uncertain",
            mode: "review",
            writing: true,
            reviewPayload: {
              body: summary,
              comments: [inline],
              event: "REQUEST_CHANGES",
              recapReviewId: "51",
            },
            providerProgress: { bulk: { writing: true } },
          }),
          review.id,
        ],
      );
      assert.equal(
        await abandonGitlabPublication(database, review.id),
        "submitted",
      );
      await processInteraction(database, review.id);
      const recovered = (await publicationView(database, review.id))
        ?.publication;
      assert.equal(recovered?.state, "unconfirmed");
      assert.equal(recovered.remoteId, "52");
      assert.equal(
        recovered.providerProgress?.bulk.confirmation,
        "response-unconfirmed",
      );
      assert.match(summaryNote.body, /GitLab verdict unconfirmed/);
      assert.ok(summaryNote.body.includes(unanchored.title));
      await processInteraction(database, review.id);
      assert.equal(bulkRequests, 0);
      // A ready transition with no source change signal also survives GitLab's pending diff.
      diffReady = false;
      start = "6".repeat(40);
      assert.equal(await deliver("mr-ready", "update", true), 202);
      diffReady = true;
      await processDeferredOpen(database);
      const {
        rows: [ready],
      } = await database.pool.query(
        "select start_sha from pull_requests where number = 27",
      );
      assert.equal(ready.start_sha, start);
      const [followup] = await listReviews(database);
      const nextAttempt = await beginAttempt(
        database,
        followup.id,
        "fixture",
        30000,
      );
      if (nextAttempt.kind !== "started")
        throw new Error("expected the follow-up review to start");
      assert.deepEqual(
        nextAttempt.source.previousFindings?.map((f) => [
          f.id,
          f.finding.title,
        ]),
        [["52:61", anchored.title]],
      );
      // The exact submitted GitLab root can discharge its own finding. An
      // unconfirmed verdict cannot clear the unanchored finding or a wrong-head note.
      const [savedReview] = await database.db
        .select()
        .from(reviews)
        .where(eq(reviews.publicId, followup.id));
      const adapter = createForge(
        {
          type: "gitlab",
          apiUrl: origin + "/api/v4",
          webUrl: origin,
          allowHttp: true,
        },
        "team/project",
      );
      /** Read the remaining findings using the live discussions and the frozen review payload. */
      const outstanding = () =>
        triageOutstanding(
          database,
          savedReview.repositoryId,
          iid,
          "9",
          adapter,
          savedReview,
        );
      assert.equal(await outstanding(), 2);
      submittedNote.resolved = true;
      assert.equal(await outstanding(), 1);
      submittedNote.position.head_sha = base;
      assert.equal(await outstanding(), 2);
      submittedNote.position.head_sha = head;
      submittedNote.resolved = false;
      // A draft update changes only GitLab's diff refs. The MR returns to its
      // reviewed revision without a ready webhook and the list omits diff_refs.
      const reviewedBase = base;
      const reviewedStart = start;
      base = "a".repeat(40);
      start = "b".repeat(40);
      draft = true;
      assert.equal(await deliver("mr-draft-during-attempt", "update"), 200);
      base = reviewedBase;
      start = reviewedStart;
      draft = false;
      await finishAttempt(
        database,
        followup.id,
        nextAttempt.attemptId,
        "fixture",
        {
          ...result,
          findingChecks: [
            {
              id: "52:61",
              status: "open",
              evidence: "The request still lacks a retry.",
            },
          ],
        },
      );
      await processInteraction(database, followup.id);
      assert.equal(
        (await publicationView(database, followup.id))?.publication?.state,
        "stale",
      );
      assert.equal(bulkRequests, 0);
      // An open listing without a verified diff cannot offer the saved verdict.
      diffReady = false;
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.equal(
        (await publicationView(database, followup.id))?.publication?.state,
        "stale",
      );
      diffReady = true;
      // Refresh observes the ready revision while the hook is off. After
      // re-enabling it, the same generation must rearm the saved review.
      config.repositories.project.webhook!.enabled = false;
      await applyWebhookSettings(database, config);
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      assert.equal(
        (await publicationView(database, followup.id))?.publication?.state,
        "stale",
      );
      config.repositories.project.webhook!.enabled = true;
      await applyWebhookSettings(database, config);
      assert.deepEqual(
        (await syncPullRequests(database, [repo.id])).failures,
        [],
      );
      const refreshed = (await publicationView(database, followup.id))
        ?.publication;
      assert.equal(refreshed?.state, "pending");
      assert.equal(refreshed.rearmed, true);
      await processInteraction(database, followup.id);
      const published = (await publicationView(database, followup.id))
        ?.publication;
      assert.equal(published?.state, "published");
      assert.equal(published.remoteId, "53");
      assert.equal(bulkRequests, 1);
      const frozen = published.reviewPayload;
      assert.ok(frozen);
      assert.deepEqual(frozen.comments, []);
      assert.equal(frozen.recapReviewId, undefined);
      assert.ok(frozen.body.includes(unanchored.title));
      summaryNote = undefined;
      discussions.length = 0;

      // A worker can stop between recording the bulk fence and sending the POST.
      // Only explicit operator recovery may clear this run's drafts and stop retries.
      assert.equal(
        await abandonGitlabPublication(database, followup.id),
        "ineligible",
      );
      /** Restore the interrupted submission with the owner recorded by that worker, if any. */
      const restoreCheckpoint = async (botId?: string) => {
        await database.pool.query(
          "update dispatch_outbox set publication = $1::jsonb where review_id = (select id from reviews where public_id = $2)",
          [
            JSON.stringify({
              state: "uncertain",
              mode: "review",
              writing: true,
              reviewPayload: { ...frozen, comments: [inline] },
              providerProgress: {
                "draft-0": { id: "41" },
                bulk: { writing: true, botId },
              },
            }),
            followup.id,
          ],
        );
      };

      await restoreCheckpoint();
      draftNote = {
        id: 41,
        author_id: 8,
        note: `${inline.body}\n\n<!-- razbor-gitlab-draft:${followup.id}:0:${head} -->`,
      };
      assert.equal(
        await abandonGitlabPublication(database, followup.id),
        "ineligible",
      );
      assert.equal(
        await abandonGitlabPublication(database, followup.id, "8"),
        "ineligible",
      );
      await assert.rejects(
        abandonGitlabPublication(database, followup.id, "9"),
      );
      assert.ok(draftNote);
      assert.equal(
        (await publicationView(database, followup.id))?.publication
          ?.providerProgress?.bulk.writing,
        true,
      );
      draftNote.author_id = 9;
      const priorBulkRequests = bulkRequests;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import=tsx",
          "scripts/manage.ts",
          "review",
          "abandon-gitlab-publication",
          followup.id,
          "--original-bot-id",
          "9",
        ],
        {
          env: {
            PATH: process.env.PATH,
            RAZBOR_DATABASE_URL: fixture.url,
          },
        },
      );
      assert.deepEqual(JSON.parse(stdout), {
        reviewId: followup.id,
        outcome: "abandoned",
      });
      assert.equal(draftNote, undefined);
      assert.equal(
        await abandonGitlabPublication(database, followup.id),
        "abandoned",
      );
      await restoreCheckpoint("8");
      assert.equal(
        await abandonGitlabPublication(database, followup.id),
        "ineligible",
      );
      assert.equal(
        (await publicationView(database, followup.id))?.publication?.state,
        "uncertain",
      );
      await restoreCheckpoint("9");
      assert.equal(
        await abandonGitlabPublication(database, followup.id),
        "abandoned",
      );
      await processInteraction(database, followup.id);
      assert.equal(
        (await publicationView(database, followup.id))?.publication?.state,
        "unconfirmed",
      );
      assert.equal(bulkRequests, priorBulkRequests);

      // A close can be delivered after the MR has already reopened. Clear the
      // opt-in before a source update can see a usable diff and beat the retry.
      config.repositories.project.reviewTriggerMode = "opt_in_continuous";
      await applyRegistry(database, config);
      for (const action of ["close", "reopen"]) {
        await database.pool.query(
          "update pull_requests set continuous_review_since = now() - interval '1 second' where number = 27",
        );
        const before = (await listReviews(database)).length;
        diffReady = false;
        assert.equal(await deliver("mr-pending-" + action, action), 202);
        const {
          rows: [boundary],
        } = await database.pool.query(
          "select state, continuous_review_since, review_session_reset_at from pull_requests where number = 27",
        );
        assert.equal(boundary.state, "open");
        assert.equal(boundary.continuous_review_since, null);
        assert.ok(boundary.review_session_reset_at);
        diffReady = true;
        start = (action === "close" ? "7" : "8").repeat(40);
        assert.equal(await deliver("mr-after-" + action, "update"), 200);
        await processDeferredOpen(database);
        assert.equal((await listReviews(database)).length, before);
      }
      // An unobserved MR has no PR row to reset. A command posted before
      // the first known reopen can run once but cannot opt the new session in.
      iid = 28;
      diffReady = false;
      const resetTime = "2026-01-01T00:00:00.000Z";
      assert.equal(
        await deliver("mr-first-reopen", "reopen", false, resetTime),
        202,
      );
      // The sender is still permitted after the settings edit. Revocation
      // consumes the original deferred work without erasing its verified reset.
      config.repositories.project.webhook!.permitted_senders.push("bob");
      await applyWebhookSettings(database, config);
      await processDeferredOpen(database);
      const {
        rows: [receipt],
      } = await database.pool.query(
        "select pending_open, open_retry_after, boundary_at from webhook_deliveries where delivery_id = 'mr-first-reopen'",
      );
      assert.equal(receipt.pending_open, null);
      assert.equal(receipt.open_retry_after, null);
      assert.equal(receipt.boundary_at.toISOString(), resetTime);
      diffReady = true;
      const priorReviews = (await listReviews(database)).length;
      /** Send a command that the GitLab adapter verifies against the note on this MR. */
      function command(id: number, deliveryId: string) {
        return acceptWebhook(
          database,
          hook!.id,
          Buffer.from(
            JSON.stringify({
              object_kind: "note",
              user: payload.user,
              project: payload.project,
              merge_request: { iid },
              object_attributes: {
                id,
                author_id: 2,
                note: "/agentic_review",
                action: "create",
                noteable_type: "MergeRequest",
              },
            }),
          ),
          {
            "x-gitlab-token": secret,
            "x-gitlab-event": "Note Hook",
            "webhook-id": deliveryId,
          },
        );
      }
      assert.equal(await command(92, "mr-delayed-command"), 202);
      const {
        rows: [first],
      } = await database.pool.query(
        "select continuous_review_since, review_session_reset_at from pull_requests where number = 28",
      );
      assert.equal(first.continuous_review_since, null);
      assert.equal(first.review_session_reset_at.toISOString(), resetTime);
      assert.equal((await listReviews(database)).length, priorReviews + 1);

      // Keep a closed observation in flight while an untracked MR reopens without a diff.
      iid = 29;
      closed = true;
      diffReady = false;
      const earlier = command(93, "mr-observed-closed");
      try {
        await Promise.race([
          closedCommandRead.promise,
          earlier.then((status) => {
            throw new Error(
              `Closed command returned HTTP ${status} before verifying its note`,
            );
          }),
        ]);
        closed = false;
        assert.equal(
          await deliver("mr-racing-reopen", "reopen", false, resetTime),
          202,
        );
        diffReady = true;
      } finally {
        releaseClosedCommand.resolve();
      }
      const earlierStatus = await earlier;
      assert.equal(await command(94, "mr-new-command"), 202);
      const {
        rows: [reopened],
      } = await database.pool.query(
        "select review_session_reset_at, continuous_review_since from pull_requests where number = 29",
      );
      assert.equal(reopened.review_session_reset_at.toISOString(), resetTime);
      assert.equal(
        reopened.continuous_review_since?.toISOString(),
        postReopenTime,
      );
      assert.equal(earlierStatus, 202);
      const beforePush = (await listReviews(database)).length;
      start = "9".repeat(40);
      assert.equal(await deliver("mr-opted-in-push", "update"), 202);
      assert.equal((await listReviews(database)).length, beforePush + 1);
    } finally {
      delete process.env.RAZBOR_TEST_MR_SECRET;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.close();
    }
  },
);
