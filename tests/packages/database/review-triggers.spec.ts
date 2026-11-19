import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  acceptWebhook,
  applyWebhookSettings,
  beginAttempt,
  connectDatabase,
  finishAttempt,
  hasEligibleRunner,
  listRepositories,
  listReviews,
  pendingDispatches,
  processDeferredOpen,
  processInteraction,
  publicationView,
  listPullRequests,
  submitReview,
  webhookView,
} from "@razbor/database";
import { applyRegistry, registrySchema } from "@razbor/database/registry";

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
  async () => {
    const fixture = await databaseFixture();
    let database = connectDatabase(fixture.url);
    const secret = "a".repeat(64);
    process.env.RAZBOR_TEST_TRIGGER_SECRET = secret;
    const bot = { id: 9, login: "razbor" };
    const author = { id: 2, login: "alice" };
    const base = "a".repeat(40);
    let head = "b".repeat(40);
    let draft = false;
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
    const observed = barrier();
    const release = barrier();
    let pauseRead = false;
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
          private: true,
          archived: false,
        });
      if (path.endsWith("/hooks"))
        return send(method === "GET" ? [] : { id: 1 });
      if (path.endsWith("/reactions")) return send(method === "GET" ? [] : {});
      if (path.endsWith("/reviews")) return send([]);
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (pull) {
        const number = Number(pull[1]);
        const response = {
          number,
          state: closed ? "closed" : "open",
          merged: false,
          draft,
          title: "Review lifecycle",
          user: author,
          html_url: origin + "/team/project/pulls/" + number,
          base: { sha: base, ref: "main" },
          head: { sha: head, ref: "fork-feature" },
          merge_base: base,
        };
        if (pauseRead) {
          pauseRead = false;
          observed.resolve();
          await release.promise;
        }
        return send(response);
      }
      const list = /\/issues\/(\d+)\/comments$/.exec(path);
      if (list) {
        const url = origin + "/team/project/pulls/" + list[1];
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
          pull_request_url: origin + "/team/project/pulls/" + commentNumber,
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
      const { rows } = await database.pool.query(
        "select origin, comment_id from review_triggers",
      );
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
    const base = "1".repeat(40),
      target = "2".repeat(40),
      head = "3".repeat(40);
    let start = target;
    let diffReady = false;
    let closed = false;
    let draftNote: { id: number; author_id: number; note: string } | undefined;
    let hideDeletion = true;
    let hookUrl: string | undefined;
    let origin = "";
    const server = createServer((req, res) => {
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
      if (path.endsWith("/merge_requests/27"))
        return send({
          iid: 27,
          project_id: 1,
          source_project_id: 2,
          target_project_id: 1,
          sha: head,
          state: closed ? "closed" : "opened",
          draft: false,
          title: "Fork MR",
          author: { id: 2, username: "alice" },
          web_url: origin + "/team/project/-/merge_requests/27",
          target_branch: "main",
          source_branch: "fork-branch",
          diff_refs: diffReady
            ? { start_sha: start, base_sha: base, head_sha: head }
            : {},
        });
      if (path.endsWith("/repository/branches/main"))
        return send({ name: "main", commit: { id: target } });
      if (path.endsWith("/draft_notes"))
        return send(draftNote ? [draftNote] : []);
      if (path.endsWith("/draft_notes/41") && req.method === "DELETE") {
        if (!hideDeletion) draftNote = undefined;
        res.statusCode = 404;
        return send({});
      }
      if (path.endsWith("/notes"))
        return send(req.method === "GET" ? [] : { id: 51 });
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
      assert.equal(
        await acceptWebhook(database, hook.id, opening, {
          "x-gitlab-token": secret,
          "x-gitlab-event": "Merge Request Hook",
          "webhook-id": "mr-open",
        }),
        202,
      );
      await processDeferredOpen(database);
      assert.equal((await listReviews(database)).length, 0);
      const restarted = connectDatabase(fixture.url);
      try {
        // Reapply identical webhook settings and confirm that the owned hook is still ready.
        await applyWebhookSettings(restarted, config);
        assert.equal((await webhookView(restarted, repo.id))?.setup, "ready");
        // Make the saved retry due without waiting for the dispatcher interval.
        await restarted.pool.query(
          "update webhook_deliveries set open_retry_after = now() where delivery_id = 'mr-open' and pending_open is not null",
        );
        diffReady = true;
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
      await acceptWebhook(database, hook.id, event, {
        "x-gitlab-token": secret,
        "x-gitlab-event": "Merge Request Hook",
        "webhook-id": "mr-new-diff",
      });
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
      await finishAttempt(
        database,
        review.id,
        reservation.attemptId,
        "fixture",
        {
          summary: "Saved result",
          findings: [],
        },
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
    } finally {
      delete process.env.RAZBOR_TEST_MR_SECRET;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.close();
    }
  },
);
