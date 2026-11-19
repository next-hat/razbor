import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";

import {
  createForge,
  ForgeOperationError,
  ForgeWebhookError,
  verifyRepository,
  ForgeReadError,
  type ForgeConnection,
  type ForgePublicationProgress,
  type ForgeType,
} from "@razbor/forge-adapters";

/** Bind an adapter to a loopback API or a non-routable URL for parser-only checks. */
function fixtureForge(type: ForgeType, origin = "https://fixture.invalid") {
  return createForge(
    {
      type,
      apiUrl: `${origin}/api/${{ github: "v3", gitlab: "v4", forgejo: "v1" }[type]}`,
      webUrl: origin,
      allowHttp: true,
      token: "local-test",
    },
    "team/project",
  );
}

/** Sign the exact provider bytes and parse them through the adapter's normal ingress. */
function lifecycleEvent(
  type: ForgeType,
  payload: unknown,
  secret = "fixture-secret",
) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const headers = {
    github: {
      "x-github-delivery": "delivery",
      "x-hub-signature-256": `sha256=${signature}`,
      "x-github-event": "pull_request",
    },
    forgejo: {
      "x-forgejo-delivery": "delivery",
      "x-forgejo-signature": signature,
      "x-forgejo-event": "pull_request",
    },
    gitlab: {
      "webhook-id": "delivery",
      "x-gitlab-token": secret,
      "x-gitlab-event": "Merge Request Hook",
    },
  };
  return fixtureForge(type).webhook(raw, headers[type], "fixture-secret");
}

test("authenticated GitHub and Forgejo lifecycle events use the provider's actual actions", () => {
  const time = "2026-02-04T03:02:01Z";
  const base = {
    repository: { id: "11234567891011121314" },
    pull_request: {
      number: 17,
      user: { id: 93, login: "owner" },
      updated_at: time,
      draft: false,
    },
  };
  for (const provider of ["github", "forgejo"] as const) {
    for (const action of ["opened", "reopened", "closed"] as const) {
      const event = lifecycleEvent(provider, { ...base, action });
      assert.ok(event && event.kind === action);
      assert.equal(event.number, 17);
      assert.equal(event.repositoryId, base.repository.id);
      assert.equal(event.occurredAt, time);
    }
    assert.equal(
      lifecycleEvent(provider, {
        ...base,
        action: provider === "github" ? "synchronize" : "synchronized",
      })?.kind,
      "updated",
    );
    assert.equal(
      lifecycleEvent(provider, { ...base, action: "assigned" }),
      undefined,
    );
    assert.throws(
      () => lifecycleEvent(provider, { ...base, action: "opened" }, "wrong"),
      ForgeWebhookError,
    );
  }
  assert.equal(
    lifecycleEvent("github", { ...base, action: "ready_for_review" })?.kind,
    "ready",
  );
  assert.equal(
    lifecycleEvent("github", { ...base, action: "converted_to_draft" })?.kind,
    "draft",
  );
  assert.equal(
    lifecycleEvent("github", {
      ...base,
      action: "edited",
      changes: {
        base: { ref: { from: "main" }, sha: { from: "a".repeat(40) } },
      },
    })?.kind,
    "updated",
  );
  assert.equal(
    lifecycleEvent("github", {
      ...base,
      action: "edited",
      changes: {
        title: { from: "Old title" },
        body: { from: "Old description" },
      },
    }),
    undefined,
  );
  assert.equal(
    lifecycleEvent("forgejo", {
      ...base,
      pull_request: { ...base.pull_request, draft: true },
      action: "edited",
      changes: { title: { from: "Ready" } },
    })?.kind,
    "draft",
  );
  assert.equal(
    lifecycleEvent("forgejo", {
      ...base,
      action: "edited",
      changes: { title: { from: "Custom draft prefix: incomplete" } },
    })?.kind,
    "ready",
  );
  assert.equal(
    lifecycleEvent("forgejo", {
      ...base,
      action: "edited",
      changes: { body: { from: "old body" } },
    }),
    undefined,
  );
  assert.ok(fixtureForge("forgejo").hookEvents.includes("pull_request_sync"));
});

test("GitLab normalizes MR code and readiness updates, ignoring metadata and foreign targets", () => {
  const attributes = {
    iid: 7,
    author_id: 33,
    target_project_id: 12,
    updated_at: "2026-02-04 03:02:01 UTC",
  };
  const payload = {
    object_kind: "merge_request",
    project: { id: 12 },
    user: { id: 93, username: "maintainer" },
  };
  /** Build an MR hook with an author distinct from the actor performing the change. */
  const event = (action: string, fields = {}, changes = {}) =>
    lifecycleEvent("gitlab", {
      ...payload,
      object_attributes: { ...attributes, action, ...fields },
      changes,
    });
  for (const [action, kind] of [
    ["open", "opened"],
    ["reopen", "reopened"],
    ["merge", "closed"],
    ["close", "closed"],
  ]) {
    const item = event(action);
    assert.ok(item && "occurredAt" in item);
    assert.equal(item.kind, kind);
    assert.equal(item.occurredAt, "2026-02-04T03:02:01Z");
  }
  assert.equal(event("update", { oldrev: "a".repeat(40) })?.kind, "updated");
  assert.equal(
    event("update", {}, { draft: { previous: false, current: true } })?.kind,
    "draft",
  );
  assert.equal(
    event(
      "update",
      {},
      { title: { previous: "test", current: "(Draft) test" } },
    )?.kind,
    "draft",
  );
  assert.equal(
    event("update", {}, { draft: { previous: true, current: false } })?.kind,
    "ready",
  );
  assert.equal(
    event("update", {}, { title: { previous: "Draft: test", current: "test" } })
      ?.kind,
    "ready",
  );
  assert.equal(
    event("update", {}, { title: { previous: "old", current: "new" } }),
    undefined,
  );
  assert.equal(event("update", {}, { reviewers: [] }), undefined);
  assert.equal(event("open", { target_project_id: 44 }), undefined);
  assert.throws(
    () => lifecycleEvent("gitlab", payload, "wrong"),
    ForgeWebhookError,
  );
});

test("current change reads use the target repository, immutable fork revisions and authoritative readiness", async (t) => {
  const origin = "https://fixture.invalid";
  const head = "1".repeat(40),
    base = "2".repeat(40),
    mergeBase = "3".repeat(40);
  let closed = false;
  let draft = true;
  let outdatedDiff = false;
  let gitlabHead = head;
  let foreign = false;
  let bulkOutcome:
    | "accepted"
    | "lost"
    | "downgraded"
    | "permission-changed"
    | "new-head"
    | "new-draft" = "accepted";
  let bulkPosts = 0;
  let summaryBody = "";
  let interruptSummaryRead = false;
  let cleanupDraft: { id: number; note: string; author_id: number } | undefined;
  let introduceDraftOnApprovalRead = false;
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    assert.equal(input.origin, origin);
    const url = input.pathname;
    if (url.endsWith("/draft_notes/bulk_publish") && init.method === "POST") {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.reviewer_state, "requested_changes");
      summaryBody = payload.note;
      bulkPosts++;
      if (bulkOutcome === "lost") throw new Error("lost response");
      if (bulkOutcome === "new-head") gitlabHead = "4".repeat(40);
      if (bulkOutcome === "new-draft") draft = true;
      interruptSummaryRead = true;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/notes/17") && init.method === "PUT") {
      summaryBody = JSON.parse(String(init.body)).body;
      return Response.json({
        id: 17,
        author: { id: 5, username: "razbor" },
        created_at: "2026-02-04T03:02:01Z",
        body: summaryBody,
      });
    }
    assert.equal(init.method, "GET");
    if (url === "/api/v4/user")
      return Response.json({ id: 5, username: "razbor" });
    if (url.endsWith("/merge_requests/12/notes")) {
      if (interruptSummaryRead) {
        interruptSummaryRead = false;
        return new Response(null, { status: 503 });
      }
      return Response.json(
        summaryBody
          ? [
              {
                id: 17,
                author: { id: 5, username: "razbor" },
                created_at: "2026-02-04T03:02:01Z",
                body: summaryBody,
              },
            ]
          : [],
      );
    }
    if (url.endsWith("/merge_requests/12/discussions"))
      return Response.json([]);
    if (url.endsWith("/merge_requests/12/draft_notes"))
      return Response.json(cleanupDraft ? [cleanupDraft] : []);
    if (url.endsWith("/merge_requests/12/approvals")) {
      if (introduceDraftOnApprovalRead)
        cleanupDraft = {
          id: 22,
          note: "Another workflow's draft",
          author_id: 5,
        };
      return Response.json({ user_can_approve: bulkOutcome !== "downgraded" });
    }
    if (url.endsWith("/merge_requests/12/reviewers"))
      return Response.json([
        {
          user: { id: 5, username: "razbor" },
          state:
            bulkOutcome === "permission-changed" || draft
              ? "reviewed"
              : "requested_changes",
        },
      ]);
    const project = foreign ? "fork/project" : "team/project";
    if (url === `/api/v3/repos/team/project/compare/${base}...${head}`)
      return Response.json({ merge_base_commit: { sha: mergeBase } });
    if (url === "/api/v4/projects/team%2Fproject/repository/branches/main")
      return Response.json({ name: "main", commit: { id: base } });
    if (url === "/api/v4/projects/team%2Fproject/merge_requests/12") {
      return Response.json({
        iid: 12,
        state: closed ? "merged" : "opened",
        web_url: `${origin}/${project}/-/merge_requests/12`,
        draft,
        title: "Fix",
        author: { id: 2, username: "author" },
        target_branch: "main",
        source_branch: "main",
        source_project_id: 99,
        sha: gitlabHead,
        diff_refs: {
          head_sha: outdatedDiff ? base : gitlabHead,
          base_sha: mergeBase,
          start_sha: base,
        },
      });
    }
    const github = url.includes("/api/v3/");
    assert.equal(
      url,
      `/api/${github ? "v3" : "v1"}/repos/team/project/pulls/12`,
    );
    return Response.json({
      number: 12,
      state: closed ? "closed" : "open",
      merged: closed,
      draft,
      html_url: `${origin}/${project}/${github ? "pull" : "pulls"}/12`,
      title: "Fix",
      user: { id: 2, login: "author" },
      head: closed
        ? null
        : { sha: head, ref: "main", repo: { full_name: "fork/project" } },
      base: { sha: base, ref: "main" },
      merge_base: mergeBase,
    });
  });
  for (const type of ["github", "forgejo", "gitlab"] as const) {
    const forge = fixtureForge(type);
    draft = true;
    closed = false;
    foreign = false;
    assert.equal((await forge.change(12)).draft, true);
    draft = false;
    const change = await forge.change(12);
    assert.deepEqual(
      [change.draft, change.headSha, change.baseSha, change.mergeBase],
      [false, head, base, mergeBase],
    );
    if (type === "gitlab") {
      outdatedDiff = true;
      await assert.rejects(
        forge.change(12),
        (error: unknown) =>
          error instanceof ForgeOperationError &&
          error.reason === "diff-pending",
      );
      outdatedDiff = false;
    }
    /** Reject revision changes and draft conversion before a native write, clearing any unsent bulk checkpoint. */
    const rejectsPublication = async (expectedBase: string) => {
      let bulkWriting = false;
      await assert.rejects(
        forge.postReview(
          12,
          head,
          "<!-- razbor:rev_abcdefghijklmnop:result -->",
          [],
          "COMMENT",
          {
            progress: {},
            revision: { ...change, baseSha: expectedBase },
            requireReady: true,
            /** Change readiness before GitLab's guarded preflight. */
            submit:
              type === "gitlab"
                ? (write) => {
                    draft = true;
                    return write();
                  }
                : undefined,
            /** Record whether the adapter classified this as a possible remote submission. */
            async save(progress) {
              bulkWriting = !!progress.bulk?.writing;
            },
          },
        ),
        (error: unknown) =>
          error instanceof ForgeOperationError &&
          error.reason === "invalid-response" &&
          !error.uncertain,
      );
      assert.equal(bulkWriting, false);
    };
    await rejectsPublication("4".repeat(40));
    draft = type !== "gitlab";
    await rejectsPublication(base);
    assert.equal(draft, true);
    if (type === "gitlab") {
      let preflight: ForgePublicationProgress = {};
      const interrupted = new Error("worker stopped before native submission");
      /** Retry the same frozen review with the durable state from its previous preflight. */
      const submitWith = (interrupt = false) =>
        forge.postReview(
          12,
          head,
          "<!-- razbor:rev_abcdefghijklmnop:result -->",
          [],
          "REQUEST_CHANGES",
          {
            revision: change,
            progress: preflight,
            requireReady: true,
            submit: interrupt
              ? async () => {
                  throw interrupted;
                }
              : undefined,
            async save(checkpoint) {
              preflight = structuredClone(checkpoint);
            },
          },
        );
      draft = false;
      await assert.rejects(submitWith(true), interrupted);
      assert.equal(structuredClone(preflight).bulk, undefined);
      introduceDraftOnApprovalRead = true;
      await assert.rejects(
        submitWith(),
        (error: unknown) =>
          error instanceof ForgeOperationError &&
          error.reason === "invalid-response" &&
          !error.uncertain,
      );
      assert.equal(bulkPosts, 0);
      assert.equal(structuredClone(preflight).bulk, undefined);
      assert.equal(cleanupDraft?.id, 22);
      cleanupDraft = undefined;
      introduceDraftOnApprovalRead = false;
      await assert.rejects(submitWith()); // This fixture interrupts the first post-submit summary read.
      assert.equal(preflight.bulk?.submitted, true);
      assert.equal(await submitWith(), "17");
      assert.equal(bulkPosts, 1);
      // Recover the notes for each submission with only the evidence captured around its own POST.
      for (const outcome of [
        "accepted",
        "lost",
        "downgraded",
        "permission-changed",
        "new-head",
        "new-draft",
      ] as const) {
        bulkOutcome = outcome;
        bulkPosts = 0;
        summaryBody = "";
        draft = false;
        outdatedDiff = false;
        gitlabHead = head;
        let saved: ForgePublicationProgress = {};
        /** Resume exactly the provider checkpoint saved by the previous call. */
        const publish = () =>
          forge.postReview(
            12,
            head,
            "<!-- razbor:rev_abcdefghijklmnop:result -->",
            [],
            "REQUEST_CHANGES",
            {
              revision: change,
              progress: saved,
              requireReady: true,
              /** Model the durable outbox boundary. */
              async save(value) {
                saved = structuredClone(value);
              },
            },
          );
        await assert.rejects(publish());
        assert.equal(
          saved.bulk.submitted,
          outcome === "lost" ? undefined : true,
        );
        assert.equal(saved.bulk.botId, "5");
        draft = true;
        outdatedDiff = false;
        assert.equal(await publish(), "17");
        if (outcome === "accepted") {
          assert.match(summaryBody, /:complete -->$/);
          assert.equal(saved.bulk.confirmation, "confirmed");
        } else {
          assert.match(summaryBody, /GitLab verdict unconfirmed/);
          assert.match(summaryBody, /:unconfirmed -->$/);
          assert.equal((await forge.reviews(12))[0]?.state, "UNCONFIRMED");
          assert.equal(
            saved.bulk.confirmation,
            outcome === "lost"
              ? "response-unconfirmed"
              : outcome === "new-draft" || outcome === "new-head"
                ? "revision-unconfirmed"
                : "verdict-unconfirmed",
          );
        }
        assert.equal(bulkPosts, 1);
      }
      let clock = Date.now();
      const time = t.mock.method(Date, "now", () => clock);
      let cleanup: ForgePublicationProgress = { "draft-0": { writing: true } };
      /** Reopen the bounded adapter as a later dispatcher retry would. */
      const retire = () =>
        fixtureForge("gitlab").discardPendingReview!(
          12,
          "rev_abcdefghijklmnop",
          cleanup,
          async (checkpoint) => {
            cleanup = structuredClone(checkpoint);
          },
        );
      try {
        await assert.rejects(retire(), ForgeOperationError);
        assert.equal(cleanup["draft-0"].missingSince, clock);
        clock += 29999;
        await assert.rejects(retire(), ForgeOperationError);
        cleanupDraft = {
          id: 41,
          author_id: 9,
          note: `finding\n\n<!-- razbor-gitlab-draft:rev_abcdefghijklmnop:0:${head} -->`,
        };
        await assert.rejects(retire(), ForgeOperationError);
        assert.equal(cleanup["draft-0"].missingSince, undefined);
        cleanupDraft = undefined;
        await assert.rejects(retire(), ForgeOperationError);
        assert.equal(cleanup["draft-0"].missingSince, clock);
        clock += 30000;
        await retire();
      } finally {
        time.mock.restore();
      }
    }
    closed = true;
    await assert.rejects(
      forge.change(12),
      (error: unknown) =>
        error instanceof ForgeOperationError &&
        error.reason === "change-closed",
    );
    foreign = true;
    await assert.rejects(
      forge.change(12),
      (error: unknown) =>
        error instanceof ForgeOperationError &&
        error.reason === "invalid-response",
    );
  }
});

test("bounded configured provider reads: paths, exact IDs, auth, errors and redirects", async () => {
  let mode = "ok";
  const seen: { url: string; auth: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({
      url: request.url!,
      auth:
        request.headers.authorization ??
        (request.headers["private-token"] as string | undefined),
    });
    if (mode === "timeout") return;
    if (mode === "redirect") {
      response.writeHead(302, { Location: `${base}/credential-trap` });
      response.end();
      return;
    }
    if (mode === "auth") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (mode === "not-found") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (mode === "oversize") {
      response.end("x".repeat(1048577));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url!.includes("projects"))
      response.end(
        `{"id":90071992547409931234,"path_with_namespace":"team/sub/project","web_url":"${base}/web/team/sub/project","visibility":"internal","archived":false,"default_branch":"main"}`,
      );
    else
      response.end(
        `{"id":90071992547409931234,"full_name":"team/project","html_url":"${base}/web/team/project","private":true,"archived":false,"default_branch":"main"}`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const type of ["github", "gitlab", "forgejo"] as const) {
      const c: ForgeConnection = {
        type,
        apiUrl: `${base}/installation/api`,
        webUrl: `${base}/web`,
        allowHttp: true,
        token: "deterministic-fixture-token",
        timeoutMs: 100,
      };
      const value = await verifyRepository(
        c,
        type === "gitlab" ? "team/sub/project" : "team/project",
      );
      assert.equal(value.externalRepositoryId, "90071992547409931234");
      assert.equal(
        seen.at(-1)!.url,
        type === "gitlab"
          ? "/installation/api/projects/team%2Fsub%2Fproject"
          : "/installation/api/repos/team/project",
      );
      assert.equal(
        seen.at(-1)!.auth,
        type === "gitlab"
          ? c.token
          : `${type === "github" ? "Bearer" : "token"} ${c.token}`,
      );
      for (const [next, reason] of [
        ["auth", "unauthorized"],
        ["not-found", "not-found"],
        ["timeout", "unavailable"],
        ["redirect", "unavailable"],
        ["oversize", "invalid-response"],
      ]) {
        mode = next;
        await assert.rejects(
          verifyRepository(c, "team/project"),
          (error: unknown) =>
            error instanceof ForgeReadError && error.reason === reason,
        );
      }
      mode = "ok";
      await assert.rejects(
        verifyRepository({ ...c, allowHttp: false }, "team/project"),
      );
    }
    assert.ok(!seen.some((r) => r.url === "/credential-trap"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("status writes verify the exact top-level owner, marker, ID and PR on all three APIs", async () => {
  const marker = "<!-- razbor:rev_abcdefghijklmnop:status -->";
  const queued = `Queued\n\n${marker}`;
  const running = `Running\n\n${marker}`;
  const writes: string[] = [];
  let provider: ForgeType = "github";
  let body = queued;
  let owner = "5";
  let commentId = "91";
  let number = 12;
  let absent = false;
  let hideSingleComment = false;
  let discussion = false;
  let loseDelete = false;
  const server = createServer(async (req, res) => {
    const route = {
      github: "/api/v3/repos/team/project/issues/comments/91",
      forgejo: "/api/v1/repos/team/project/issues/comments/91",
      gitlab: "/api/v4/projects/team%2Fproject/merge_requests/12/notes/91",
    }[provider];
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, origin);
    const listing =
      provider === "gitlab"
        ? route.slice(0, -3)
        : route.replace("/issues/comments/91", "/issues/12/comments");
    const user = { id: owner, login: "account", username: "account" };
    if (req.method === "GET" && url.pathname === listing) {
      const page = Number(url.searchParams.get("page"));
      const entry = {
        id: commentId,
        body,
        user,
        author: user,
        created_at: "2026-02-04T03:02:01Z",
      };
      // GitLab's final data page needs an empty-page probe even after deletion.
      // The other providers model a server that caps each page at one comment.
      const pageSize = provider === "gitlab" ? 50 : 1;
      const entries = Array.from(
        { length: provider === "gitlab" ? 999 : 1 },
        (_, index) => ({ ...entry, id: String(1000 + index) }),
      );
      if (!absent) entries.push(entry);
      res.end(
        JSON.stringify(entries.slice((page - 1) * pageSize, page * pageSize)),
      );
      return;
    }
    assert.equal(req.url, route);
    if (req.method === "GET" && (absent || hideSingleComment)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          id: commentId,
          user,
          author: user,
          body,
          system: false,
          issue_url: `${origin}/api/v3/repos/team/project/issues/${number}`,
          pull_request_url: `${origin}/team/project/pulls/${number}`,
          created_at: "2026-02-04T03:02:01Z",
          noteable_type: "MergeRequest",
          noteable_iid: number,
          type: discussion ? "DiscussionNote" : null,
        }),
      );
      return;
    }
    writes.push(req.method!);
    if (req.method === "DELETE") {
      absent = true;
      if (loseDelete) res.destroy();
      else res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString()).body;
    res.end(JSON.stringify({ id: commentId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (provider of ["github", "forgejo", "gitlab"] as const) {
      writes.length = 0;
      body = queued;
      absent = false;
      const forge = fixtureForge(provider, origin);
      /** Exercise an untrusted response without touching any provider comment. */
      const rejectWrite = async () => {
        await assert.rejects(
          forge.deleteStatusComment(12, "91", "5", marker),
          ForgeOperationError,
        );
        await assert.rejects(
          forge.editStatusComment(12, "91", "5", marker, running),
          ForgeOperationError,
        );
        assert.deepEqual(writes, []);
      };
      owner = "6";
      await rejectWrite();
      owner = "5";
      number = 13;
      await rejectWrite();
      number = 12;
      commentId = "92";
      await rejectWrite();
      commentId = "91";
      body = "Queued\n\n<!-- razbor:rev_abcdefghijklmnop:welcome -->";
      await rejectWrite();
      body = queued;
      hideSingleComment = true;
      await rejectWrite();
      hideSingleComment = false;
      if (provider === "gitlab") {
        discussion = true;
        await rejectWrite();
        discussion = false;
      }
      await forge.editStatusComment(12, "91", "5", marker, running);
      assert.equal(body, running);
      loseDelete = true;
      await assert.rejects(
        forge.deleteStatusComment(12, "91", "5", marker),
        (error: unknown) =>
          error instanceof ForgeOperationError && error.uncertain,
      );
      loseDelete = false;
      await forge.deleteStatusComment(12, "91", "5", marker);
      assert.deepEqual(writes, [
        provider === "gitlab" ? "PUT" : "PATCH",
        "DELETE",
      ]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
