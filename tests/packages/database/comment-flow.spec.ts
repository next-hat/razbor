import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  reviewCommand,
  preparePublication,
  applyWebhookSettings,
  acceptWebhook,
  listRepositories,
  listReviews,
  pendingDispatches,
  beginAttempt,
  finishAttempt,
  connectDatabase,
  processInteraction,
  processInteractions,
  processStatusComments,
  publicationView,
  removeRepositoryWebhook,
  requestRepositoryDeletion,
  webhookView,
} from "@razbor/database";
import { applyRegistry, registrySchema } from "@razbor/database/registry";
import {
  verifyForgejoWebhook,
  parseForgejoComment,
} from "@razbor/forge-adapters";

import { databaseFixture } from "@tests/packages/database/fixture.js";

test("leading commands, raw-byte HMAC, PR-only events and exact diff locations", () => {
  assert.equal(reviewCommand("/agentic_review\nplease check"), true);
  for (const body of [
    "/agentic_reviewer",
    "look /agentic_review",
    "> /agentic_review",
    "```\n/agentic_review",
    "    /agentic_review",
  ])
    assert.equal(reviewCommand(body), false);
  const body = Buffer.from('{"body":"hello"}');
  const signature = createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifyForgejoWebhook(body, signature, "secret"), true);
  assert.equal(
    verifyForgejoWebhook(
      Buffer.concat([body, Buffer.from(" ")]),
      signature,
      "secret",
    ),
    false,
  );
  assert.equal(verifyForgejoWebhook(body, "00", "secret"), false);
  const event = {
    action: "created",
    is_pull: true,
    issue: { number: 1 },
    comment: {
      id: 2,
      body: "/agentic_review",
      user: { id: 3, login: "alice" },
    },
    sender: { id: 3, login: "alice" },
    repository: { id: 4 },
  };
  assert.ok(
    parseForgejoComment(Buffer.from(JSON.stringify(event)), "issue_comment"),
  );
  assert.equal(
    parseForgejoComment(
      Buffer.from(JSON.stringify({ ...event, is_pull: false })),
      "issue_comment",
    ),
    undefined,
  );
  assert.equal(
    parseForgejoComment(
      Buffer.from(JSON.stringify({ ...event, action: "edited" })),
      "issue_comment",
    ),
    undefined,
  );
  const finding = {
    severity: "high" as const,
    path: "timer.ts",
    lineStart: 2,
    lineEnd: 3,
    title: "Timer leaks after shutdown",
    body: "The timer survives.",
    failureScenario: "Closing leaves the timer running.",
    suggestion: "Clear the timer in cleanup.",
  };
  const diff =
    "diff --git a/timer.ts b/timer.ts\n--- a/timer.ts\n+++ b/timer.ts\n@@ -2,1 +2,2 @@\n context\n+new timer\n";
  const result = preparePublication(
    {
      summary: "Review",
      findings: [
        finding,
        { ...finding, lineStart: 4, lineEnd: 4 },
        {
          ...finding,
          title: "Another bug",
          failureScenario: "Different scenario",
          lineStart: 20,
          lineEnd: 20,
        },
      ],
    },
    diff,
    "rev_abcdefghijklmnop",
  );
  assert.equal(result.count, 2);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].lineStart, 2);
  assert.equal(result.comments[0].lineEnd, 3);
  assert.equal(result.limitations.length, 1);
  assert.ok(!result.comments[0].body.includes("```suggestion"));
});

test(
  "persist before acknowledgement; delivery/comment dedup; fallback, hook reconciliation and automatic publication",
  { timeout: 60000 },
  async () => {
    const fixture = await databaseFixture();
    const db = fixture.database;
    const secret = "a".repeat(64);
    process.env.RAZBOR_TEST_HOOK_SECRET = secret;
    const hooks: { id: number; type: string; config: { url: string } }[] = [];
    const posted: {
      id: number;
      body: string;
      user: { id: number; login: string };
    }[] = [];
    const native: {
      id: number;
      body: string;
      commit_id: string;
      state: string;
      user: { id: number; login: string };
    }[] = [];
    let reviewWrites = 0;
    let loseNativeResponse = false;
    let failReviewList = false;
    let reactionReads = 0;
    let nextNoteId = 100;
    let loseStatusCreate = true;
    let loseStatusDelete = true;
    let maskStatusEdit = false;
    const deletions: number[] = [];
    let head = "b".repeat(40);
    let open = true;
    let observedAt = new Date();
    let privateRepo = true;
    let resetAtSubmission:
      { reviewId: string; reset(): Promise<void> } | undefined;
    const originalBot = { id: 9, login: "razbor" };
    let bot = originalBot;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const input = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const route = new URL(req.url!, "http://localhost").pathname;
      res.setHeader("Content-Type", "application/json");
      /** Serialize the fixture forge response as JSON and finish the HTTP response. */
      const reply = (v: unknown) => res.end(JSON.stringify(v));
      if (route.endsWith("/user")) return reply(bot);
      if (route.endsWith("/repos/team/project"))
        return reply({
          id: 1,
          full_name: "team/project",
          html_url: `${origin}/team/project`,
          private: privateRepo,
          archived: false,
        });
      if (route.endsWith("/hooks") && req.method === "GET") return reply(hooks);
      if (route.endsWith("/hooks") && req.method === "POST") {
        hooks.push({ id: 1, type: "forgejo", config: input.config });
        assert.deepEqual(input.events, [
          "pull_request",
          "pull_request_sync",
          "pull_request_comment",
          "push",
        ]);
        return reply({ id: 1 });
      }
      if (route.endsWith("/hooks/1") && req.method === "PATCH")
        return reply({ id: 1 });
      if (route.endsWith("/reactions")) {
        if (req.method === "GET") {
          reactionReads++;
          return reply(null);
        }
        res.statusCode = 405;
        return reply({});
      }
      if (/\/issues\/comments\/\d+$/.test(route)) {
        const id = Number(route.split("/").at(-1));
        if (id >= 100) {
          const index = posted.findIndex((note) => note.id === id);
          const note = posted[index];
          if (!note || (maskStatusEdit && req.method === "PATCH")) {
            res.statusCode = 404;
            return reply({});
          }
          if (req.method === "PATCH" || req.method === "DELETE")
            assert.equal(note.user.id, bot.id);
          if (req.method === "PATCH") note.body = input.body;
          if (req.method === "DELETE") {
            deletions.push(note.id);
            posted.splice(index, 1);
            if (loseStatusDelete) {
              loseStatusDelete = false;
              res.statusCode = 503;
            }
          }
          return reply({
            ...note,
            issue_url: "",
            pull_request_url: `${origin}/team/project/pulls/7`,
          });
        }
        return reply({
          id,
          body: "/agentic_review",
          user: { id: 2, login: "alice" },
          created_at: observedAt.toISOString(),
          issue_url: "",
          pull_request_url: `${origin}/team/project/pulls/7`,
        });
      }
      if (route.endsWith("/pulls/7")) {
        if (
          resetAtSubmission &&
          (await publicationView(db, resetAtSubmission.reviewId))?.publication
            ?.writing
        ) {
          const reset = resetAtSubmission.reset;
          resetAtSubmission = undefined;
          await reset();
        }
        return reply({
          number: 7,
          state: open ? "open" : "closed",
          draft: false,
          merged: false,
          title: "Fix timer",
          html_url: `${origin}/team/project/pulls/7`,
          base: { sha: "a".repeat(40) },
          head: { sha: head },
          merge_base: "a".repeat(40),
        });
      }
      if (route.endsWith("/issues/7/comments")) {
        if (req.method === "POST") {
          assert.equal((await listReviews(db)).length > 0, true);
          posted.push({ id: nextNoteId++, body: input.body, user: bot });
          if (input.body.endsWith(":status -->") && loseStatusCreate) {
            loseStatusCreate = false;
            res.statusCode = 503;
          }
          return reply(posted.at(-1));
        }
        const page = new URL(req.url!, origin).searchParams.get("page");
        return reply(
          page && Number(page) > 1 ? [] : posted.length ? posted : null,
        );
      }
      if (route.endsWith("/pulls/7.diff"))
        return res.end(
          "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1,2 @@\n+new code\n+new cleanup\n",
        );
      if (route.endsWith("/pulls/7/reviews")) {
        if (req.method === "POST") {
          reviewWrites++;
          assert.equal(input.commit_id, head);
          if (reviewWrites === 1) {
            assert.equal(input.comments[0].new_position, 2);
            assert.equal(
              Object.hasOwn(input.comments[0], "extra_lines_count"),
              false,
            );
            assert.equal(input.event, "REQUEST_CHANGES");
          }
          native.push({
            id: 20 + native.length,
            body: input.body,
            commit_id: input.commit_id,
            state: input.event,
            user: bot,
          });
          if (loseNativeResponse) {
            loseNativeResponse = false;
            res.statusCode = 503;
          }
          return reply({ id: native.at(-1)!.id });
        }
        if (failReviewList) {
          res.statusCode = 503;
          return reply({});
        }
        return reply(native);
      }
      if (route.endsWith("/reviews/20/comments"))
        return reply([
          {
            id: 21,
            body: `<!-- razbor:${(await listReviews(db))[0].id}:finding -->`,
            path: "file.ts",
          },
        ]);
      if (/\/reviews\/\d+\/comments$/.test(route)) return reply([]);
      res.statusCode = 404;
      reply({});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const config = registrySchema.parse({
        registry: { key: "test" },
        forges: {
          forge: {
            type: "forgejo",
            api_url: `${origin}/api/v1`,
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
              secret: { env: "RAZBOR_TEST_HOOK_SECRET" },
              permitted_senders: ["*"],
            },
          },
        },
      });
      await applyRegistry(db, config);
      await applyWebhookSettings(db, config);
      await applyWebhookSettings(db, config);
      assert.equal(hooks.length, 1);
      const repo = (await listRepositories(db))[0];
      const hook = (await webhookView(db, repo.id))!;
      assert.equal(hook.setup, "ready");
      const push = Buffer.from(
        JSON.stringify({
          ref: "refs/heads/main",
          after: head,
          repository: { id: 1 },
        }),
      );
      const pushHeaders = {
        "x-forgejo-delivery": "push",
        "x-forgejo-event": "push",
        "x-forgejo-signature": createHmac("sha256", secret)
          .update(push)
          .digest("hex"),
      };
      let refreshed = 0;
      /** Count local refresh requests without starting an index or embedding backend. */
      const refresh = async () => {
        refreshed++;
      };
      assert.equal(
        await acceptWebhook(db, hook.id, push, pushHeaders, refresh),
        200,
      );
      config.repositories.project.codebaseMemoryEnabled = false;
      config.repositories.project.indexing.persistent = true;
      await applyRegistry(db, config);
      assert.equal((await listRepositories(db))[0].verifiedAt, repo.verifiedAt);
      assert.equal(
        await acceptWebhook(
          db,
          hook.id,
          push,
          { ...pushHeaders, "x-forgejo-delivery": "source-only-push" },
          refresh,
        ),
        204,
      );
      assert.equal(refreshed, 1);
      /** Submit a signed Forgejo comment webhook with selectable delivery and comment IDs to exercise deduplication. */
      async function deliver(delivery: string, comment = 10) {
        const raw = Buffer.from(
          JSON.stringify({
            action: "created",
            is_pull: true,
            issue: { number: 7 },
            repository: { id: 1 },
            sender: { id: 2, login: "alice" },
            comment: {
              id: comment,
              body: "/agentic_review",
              user: { id: 2, login: "alice" },
            },
          }),
        );
        return acceptWebhook(db, hook.id, raw, {
          "x-forgejo-delivery": delivery,
          "x-forgejo-event": "issue_comment",
          "x-forgejo-signature": createHmac("sha256", secret)
            .update(raw)
            .digest("hex"),
        });
      }
      assert.equal(await deliver("first"), 202);
      assert.equal((await pendingDispatches(db)).length, 1);
      assert.equal(await deliver("first"), 202);
      assert.equal(await deliver("redelivery"), 202);
      assert.equal(posted.length, 0);
      assert.equal(reactionReads, 1);
      assert.equal((await listReviews(db)).length, 1);
      const review = (await listReviews(db))[0];
      /** Advance only the durable status retry deadline without sleeping or changing review state. */
      async function retryStatus() {
        await db.pool.query(
          "update dispatch_outbox set status_after=null where review_id=(select id from reviews where public_id=$1)",
          [review.id],
        );
        await processStatusComments(db);
      }
      await processStatusComments(db);
      assert.equal(posted.length, 1);
      const status = posted[0];
      assert.match(status.body, /Razbor review queued/);
      assert.ok(status.body.includes(head.slice(0, 12)));
      assert.equal((await pendingDispatches(db)).length, 1);
      const human = {
        ...status,
        id: nextNoteId++,
        user: { id: 2, login: "alice" },
      };
      posted.push(human);
      // A new pool can recover the exact bot-owned comment after a lost POST.
      const restarted = connectDatabase(fixture.url);
      try {
        await db.pool.query("update dispatch_outbox set status_after=null");
        await processStatusComments(restarted);
      } finally {
        await restarted.close();
      }
      assert.equal(posted.length, 2);
      const attempt = await beginAttempt(db, review.id, "test", 30000);
      assert.equal(attempt.kind, "started");
      if (attempt.kind !== "started") throw new Error();
      assert.equal(attempt.codebaseMemoryEnabled, false);
      // A masked 404 with the original still visible must preserve its ID for a later edit.
      maskStatusEdit = true;
      await processStatusComments(db);
      assert.match(status.body, /Razbor review queued/);
      maskStatusEdit = false;
      await retryStatus();
      assert.match(status.body, /Razbor is reviewing/);
      assert.match(human.body, /Razbor review queued/);
      await finishAttempt(db, review.id, attempt.attemptId, "test", {
        summary: "One finding",
        findings: [
          {
            severity: "high",
            path: "file.ts",
            lineStart: 1,
            lineEnd: 2,
            title: "Missing cleanup",
            body: "The timer is retained",
            failureScenario: "After shutdown",
            suggestion: "Clear the timer",
          },
        ],
      });
      await processStatusComments(db);
      assert.ok(
        posted.includes(status),
        "retain status while publication is pending",
      );
      assert.match(status.body, /Final publication is pending/);
      await processInteraction(db, review.id);
      await processInteraction(db, review.id);
      assert.equal(reviewWrites, 1);
      assert.equal(
        (await publicationView(db, review.id))?.publication?.state,
        "published",
      );
      // Neither a human-owned note nor another review's marker is an admissible cleanup target.
      status.user = human.user;
      await processStatusComments(db);
      assert.deepEqual(deletions, []);
      status.user = bot;
      const savedBody = status.body;
      status.body = status.body.replace(review.id, "rev_0000000000000000");
      await retryStatus();
      assert.deepEqual(deletions, []);
      status.body = savedBody;
      await retryStatus();
      await retryStatus();
      assert.deepEqual(deletions, [status.id]);
      assert.ok(posted.includes(human));
      assert.equal(
        (await publicationView(db, review.id))?.statusCommentError,
        undefined,
      );
      privateRepo = false;
      assert.equal(await deliver("public", 11), 403);
      assert.equal((await listReviews(db)).length, 1);
      privateRepo = true;
      // A fresh comment is a distinct request; a later head change is reported stale.
      assert.equal(await deliver("fresh", 11), 202);
      const next = (await listReviews(db))[0];
      await processStatusComments(db);
      const missingIndex = posted.findIndex((note) =>
        note.body.endsWith(`<!-- razbor:${next.id}:status -->`),
      );
      assert.ok(missingIndex >= 0);
      const [removed] = posted.splice(missingIndex, 1);
      const second = await beginAttempt(db, next.id, "test", 30000);
      assert.equal(second.kind, "started");
      if (second.kind !== "started") throw new Error();
      await processStatusComments(db);
      await processStatusComments(db);
      const replacements = posted.filter((note) =>
        note.body.endsWith(`<!-- razbor:${next.id}:status -->`),
      );
      assert.equal(replacements.length, 1);
      assert.notEqual(replacements[0].id, removed.id);
      assert.match(replacements[0].body, /Razbor is reviewing/);
      await finishAttempt(db, next.id, second.attemptId, "test", {
        summary: "",
        findings: [],
      });
      head = "c".repeat(40);
      await processInteraction(db, next.id);
      assert.equal(
        (await publicationView(db, next.id))?.publication?.state,
        "stale",
      );
      assert.equal(reviewWrites, 1);
      await processStatusComments(db);
      assert.equal(
        posted.filter(
          (note) =>
            note.body.includes(next.id) && note.body.endsWith(":status -->"),
        ).length,
        0,
      );
      assert.ok(
        posted.some(
          (note) =>
            note.body.includes(next.id) && note.body.includes("is stale"),
        ),
      );
      assert.equal(await deliver("failed", 12), 202);
      const failed = (await listReviews(db))[0];
      await processStatusComments(db);
      const failedAttempt = await beginAttempt(db, failed.id, "test", 30000);
      assert.equal(failedAttempt.kind, "started");
      if (failedAttempt.kind !== "started") throw new Error();
      await finishAttempt(
        db,
        failed.id,
        failedAttempt.attemptId,
        "test",
        undefined,
        true,
      );
      await processInteraction(db, failed.id);
      await processStatusComments(db);
      assert.ok(
        posted.some(
          (note) =>
            note.body.includes(failed.id) && note.body.includes("failed."),
        ),
      );
      assert.ok(
        !posted.some(
          (note) =>
            note.body.includes(failed.id) && note.body.endsWith(":status -->"),
        ),
      );
      assert.equal(reviewWrites, 1);
      // Publish revision C while the completed revision B has only a stale
      // notice. Reopening at B must publish its saved result without inference.
      assert.equal(await deliver("intervening", 14), 202);
      const intervening = (await listReviews(db))[0];
      const third = await beginAttempt(db, intervening.id, "test", 30000);
      assert.equal(third.kind, "started");
      if (third.kind !== "started") throw new Error();
      await finishAttempt(db, intervening.id, third.attemptId, "test", {
        summary: "Reviewed revision C",
        findings: [],
      });
      await processInteraction(db, intervening.id);
      const otherSummary = native.find((note) =>
        note.body.includes(intervening.id),
      );
      assert.ok(otherSummary);
      const frozenSummary = { ...otherSummary };
      config.repositories.project.reviewTriggerMode = "automatic";
      await applyRegistry(db, config);
      head = "b".repeat(40);
      /** Send provider-timestamped lifecycle events through the signed webhook ingress. */
      async function lifecycle(action: string, delivery: string) {
        const body = Buffer.from(
          JSON.stringify({
            action,
            repository: { id: 1 },
            pull_request: {
              number: 7,
              user: { id: 2, login: "alice" },
              updated_at: observedAt.toISOString(),
            },
          }),
        );
        return acceptWebhook(db, hook.id, body, {
          "x-forgejo-event": "pull_request",
          "x-forgejo-delivery": delivery,
          "x-forgejo-signature": createHmac("sha256", secret)
            .update(body)
            .digest("hex"),
        });
      }
      const count = (await listReviews(db)).length;
      assert.ok(
        (await lifecycle("reopened", "reopen-at-reviewed-revision")) < 300,
      );
      assert.equal((await listReviews(db)).length, count);
      const reopened = (await publicationView(db, next.id))?.publication;
      assert.equal(reopened?.state, "pending");
      assert.equal(reopened.rearmed, true);
      // The provider moved again before the rearmed result could be published.
      head = "c".repeat(40);
      await processInteraction(db, next.id);
      assert.equal(
        (await publicationView(db, next.id))?.publication?.state,
        "stale",
      );
      head = "b".repeat(40);
      assert.equal(
        await lifecycle("synchronized", "same-session-revision"),
        202,
      );
      assert.equal(
        (await publicationView(db, next.id))?.publication?.state,
        "stale",
      );
      // A later observed C -> B transition grants one new publication attempt.
      head = "c".repeat(40);
      assert.equal(
        await lifecycle("synchronized", "observe-intervening-head"),
        202,
      );
      head = "b".repeat(40);
      assert.equal(
        await lifecycle("synchronized", "restore-reviewed-head"),
        202,
      );
      await processInteraction(db, next.id);
      assert.equal(
        (await publicationView(db, next.id))?.publication?.state,
        "published",
      );
      assert.equal(
        native.filter((note) => note.body.includes(next.id)).length,
        1,
      );
      assert.deepEqual(otherSummary, frozenSummary);
      assert.ok(
        posted.some(
          (note) =>
            note.body.includes(next.id) && note.body.includes("is stale"),
        ),
      );
      await processInteraction(db, next.id);
      assert.equal(reviewWrites, 3);
      assert.equal((await pendingDispatches(db)).length, 0);
      config.repositories.project.reviewTriggerMode = "opt_in_continuous";
      await applyRegistry(db, config);
      observedAt = new Date(Date.now() + 1000);
      assert.equal(await deliver("activate-before-close", 15), 202);
      head = "e".repeat(40);
      assert.ok(
        (await lifecycle("synchronized", "changed-after-activation")) < 300,
      );
      const beforeClose = (await listReviews(db))[0];
      assert.equal(
        (await publicationView(db, beforeClose.id))?.origin,
        "automatic",
      );
      const running = await beginAttempt(db, beforeClose.id, "test", 30000);
      assert.equal(running.kind, "started");
      if (running.kind !== "started") throw new Error();
      resetAtSubmission = {
        reviewId: beforeClose.id,
        /** Close and reopen at the same revision after the publisher saves its native-write checkpoint. */
        async reset() {
          open = false;
          observedAt = new Date(observedAt.getTime() + 1000);
          assert.ok(
            (await lifecycle("closed", "close-before-submission")) < 300,
          );
          open = true;
          observedAt = new Date(observedAt.getTime() + 1000);
          assert.ok(
            (await lifecycle("reopened", "reopen-without-opt-in")) < 300,
          );
        },
      };
      await finishAttempt(db, beforeClose.id, running.attemptId, "test", {
        summary: "From the previous open session",
        findings: [],
      });
      await processInteraction(db, beforeClose.id);
      assert.equal(resetAtSubmission, undefined);
      assert.equal(reviewWrites, 3);
      await processInteraction(db, beforeClose.id);
      assert.equal(
        (await publicationView(db, beforeClose.id))?.publication?.state,
        "stale",
      );
      assert.ok(!native.some((note) => note.body.includes(beforeClose.id)));
      head = "f".repeat(40);
      assert.equal(await deliver("disable-before-native-post", 17), 202);
      const [beforeDisable] = await listReviews(db);
      const explicit = await beginAttempt(db, beforeDisable.id, "test", 30000);
      if (explicit.kind !== "started")
        throw new Error("expected explicit review to start");
      await finishAttempt(db, beforeDisable.id, explicit.attemptId, "test", {
        summary: "Explicit review across webhook disablement",
        findings: [],
      });
      resetAtSubmission = {
        reviewId: beforeDisable.id,
        /** Disable the hook after its checkpoint but before the first native POST. */
        async reset() {
          config.repositories.project.webhook!.enabled = false;
          await applyWebhookSettings(db, config);
        },
      };
      await processInteraction(db, beforeDisable.id);
      assert.equal(resetAtSubmission, undefined);
      assert.equal(reviewWrites, 3);
      config.repositories.project.webhook!.enabled = true;
      await applyWebhookSettings(db, config);
      loseNativeResponse = true;
      await processInteraction(db, beforeDisable.id);
      assert.equal(reviewWrites, 4);
      assert.equal(
        (await publicationView(db, beforeDisable.id))?.publication?.state,
        "uncertain",
      );
      config.repositories.project.webhook!.enabled = false;
      await applyWebhookSettings(db, config);
      failReviewList = true;
      await processInteraction(db, beforeDisable.id);
      assert.equal(
        (await publicationView(db, beforeDisable.id))?.publication?.writing,
        true,
      );
      failReviewList = false;
      await db.pool.query(
        "update dispatch_outbox set interaction_after = now() where review_id = (select id from reviews where public_id = $1)",
        [beforeDisable.id],
      );
      await processInteractions(db);
      assert.equal(
        (await publicationView(db, beforeDisable.id))?.publication?.state,
        "published",
      );
      assert.equal(reviewWrites, 4);
      config.repositories.project.webhook!.enabled = true;
      await applyWebhookSettings(db, config);
      assert.equal(await deliver("retire", 13), 202);
      const retiring = (await listReviews(db))[0];
      await processStatusComments(db);
      /** Find this PR's current status for the exact retiring run. */
      const retiringStatus = () =>
        posted.find((note) =>
          note.body.endsWith(`<!-- razbor:${retiring.id}:status -->`),
        );
      const oldStatus = retiringStatus();
      assert.ok(oldStatus);
      const replacementBot = { id: 19, login: "new-review-bot" };
      bot = replacementBot;
      await applyWebhookSettings(db, config);
      await processStatusComments(db);
      assert.equal(
        (await publicationView(db, retiring.id))?.statusCommentError,
        "status-comment-owner-changed",
      );
      assert.equal(retiringStatus(), oldStatus);
      // Restoring the original bot wakes the row immediately, even with the hourly check pending.
      bot = originalBot;
      await applyWebhookSettings(db, config);
      await processStatusComments(db);
      assert.equal(
        (await publicationView(db, retiring.id))?.statusCommentError,
        undefined,
      );
      assert.equal(retiringStatus(), oldStatus);
      bot = replacementBot;
      await applyWebhookSettings(db, config);
      await processStatusComments(db);
      posted.splice(posted.indexOf(oldStatus), 1);
      await db.pool.query(
        "update dispatch_outbox set status_after=null where review_id=(select id from reviews where public_id=$1)",
        [retiring.id],
      );
      await processStatusComments(db);
      await processStatusComments(db);
      assert.equal(retiringStatus()?.user.id, replacementBot.id);
      config.repositories.project.webhook!.enabled = false;
      await applyWebhookSettings(db, config);
      await processStatusComments(db);
      assert.ok(!retiringStatus());
      config.repositories.project.webhook!.enabled = true;
      await applyWebhookSettings(db, config);
      await processStatusComments(db);
      assert.ok(retiringStatus());
      bot = originalBot;
      await applyWebhookSettings(db, config);
      await processStatusComments(db);
      await requestRepositoryDeletion(db, repo.id, {
        confirmation: "team/project",
      });
      assert.equal(await removeRepositoryWebhook(db, repo.id), false);
      const {
        rows: [deleting],
      } = await db.pool.query(
        "select setup_error from repositories where public_id=$1",
        [repo.id],
      );
      assert.match(deleting.setup_error, /previous bot/);
      bot = replacementBot;
      await db.pool.query("update dispatch_outbox set status_after=null");
      await processStatusComments(db);
      assert.ok(!retiringStatus());
      assert.ok(posted.includes(human));
    } finally {
      delete process.env.RAZBOR_TEST_HOOK_SECRET;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.close();
    }
  },
);
