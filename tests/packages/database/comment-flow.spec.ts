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
  processInteraction,
  publicationView,
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
    let reactionReads = 0;
    let head = "b".repeat(40);
    let privateRepo = true;
    const bot = { id: 9, login: "razbor" };
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
      if (/\/issues\/comments\/\d+$/.test(route))
        return reply({
          id: Number(route.split("/").at(-1)),
          body: "/agentic_review",
          user: { id: 2, login: "alice" },
          issue_url: "",
          pull_request_url: `${origin}/team/project/pulls/7`,
        });
      if (route.endsWith("/pulls/7"))
        return reply({
          number: 7,
          state: "open",
          merged: false,
          title: "Fix timer",
          html_url: `${origin}/team/project/pulls/7`,
          base: { sha: "a".repeat(40) },
          head: { sha: head },
          merge_base: "a".repeat(40),
        });
      if (route.endsWith("/issues/7/comments")) {
        if (req.method === "POST") {
          assert.equal((await listReviews(db)).length > 0, true);
          if (input.body.startsWith("Review queued")) {
            const latest = (await listReviews(db))[0];
            assert.ok(
              !(await pendingDispatches(db)).some(
                (j) => j.reviewId === latest.id,
              ),
            );
          }
          posted.push({ id: posted.length + 1, body: input.body, user: bot });
          return reply(posted.at(-1));
        }
        return reply(posted.length ? posted : null);
      }
      if (route.endsWith("/pulls/7.diff"))
        return res.end(
          "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1,2 @@\n+new code\n+new cleanup\n",
        );
      if (route.endsWith("/pulls/7/reviews")) {
        if (req.method === "POST") {
          reviewWrites++;
          assert.equal(input.commit_id, "b".repeat(40));
          assert.equal(input.comments[0].new_position, 2);
          assert.equal(
            Object.hasOwn(input.comments[0], "extra_lines_count"),
            false,
          );
          assert.equal(input.event, "REQUEST_CHANGES");
          native.push({
            id: 20,
            body: input.body,
            commit_id: input.commit_id,
            state: "REQUEST_CHANGES",
            user: bot,
          });
          return reply({ id: 20 });
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
      assert.equal(posted.length, 1);
      assert.equal((await pendingDispatches(db)).length, 1);
      assert.equal(await deliver("first"), 202);
      assert.equal(await deliver("redelivery"), 202);
      assert.equal(posted.length, 1);
      assert.equal(reactionReads, 1);
      assert.equal((await listReviews(db)).length, 1);
      const review = (await listReviews(db))[0];
      const attempt = await beginAttempt(db, review.id, "test", 30000);
      assert.equal(attempt.kind, "started");
      if (attempt.kind !== "started") throw new Error();
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
      await processInteraction(db, review.id);
      await processInteraction(db, review.id);
      assert.equal(reviewWrites, 1);
      assert.equal(
        (await publicationView(db, review.id))?.publication?.state,
        "published",
      );
      privateRepo = false;
      assert.equal(await deliver("public", 11), 403);
      assert.equal((await listReviews(db)).length, 1);
      privateRepo = true;
      // A fresh comment is a distinct request; a later head change is reported stale.
      assert.equal(await deliver("fresh", 11), 202);
      const next = (await listReviews(db))[0];
      const second = await beginAttempt(db, next.id, "test", 30000);
      assert.equal(second.kind, "started");
      if (second.kind !== "started") throw new Error();
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
    } finally {
      delete process.env.RAZBOR_TEST_HOOK_SECRET;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.close();
    }
  },
);
