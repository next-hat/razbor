import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test, type TestContext } from "node:test";

import {
  createForge,
  createGithubInstallationToken,
  listGithubInstallationRepositories,
  forgeMergeReason,
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeWriteStage,
  type ForgeType,
} from "@razbor/forge-adapters";

const headSha = "a".repeat(40);

const baseSha = "b".repeat(40);

const request: ForgeMergeRequest = {
  externalRepositoryId: "10",
  number: 7,
  reviewId: "rev_0123456789abcdef",
  baseBranch: "main",
  baseSha,
  headSha,
  method: "squash",
  requirePassingChecks: true,
};

/** Bind the actual provider transport to an offline fetch fixture. */
function forge(type: ForgeType) {
  return createForge(
    {
      type,
      webUrl: "https://fixture.invalid",
      apiUrl: `https://fixture.invalid/api/${{ github: "v3", gitlab: "v4", forgejo: "v1" }[type]}`,
      allowHttp: false,
      token: "fixture",
      githubAppBot: { id: "2", appId: "1", login: "razbor[bot]" },
    },
    "team/project",
  );
}

/** Supply provider-shaped bytes without exposing network access. */
function fakeFetch(
  t: TestContext,
  handler: (
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) => unknown,
) {
  t.mock.method(globalThis, "fetch", async (url: URL, opts: RequestInit) => {
    assert.equal(url.hostname, "fixture.invalid");
    const result = handler(
      url.pathname + url.search,
      opts.method ?? "GET",
      opts.body ? JSON.parse(String(opts.body)) : {},
    );
    return result instanceof Response ? result : Response.json(result);
  });
}

const checkName = "Razbor / merge eligibility";

/** A persisted eligibility run from an older dispatcher on the reviewed commit. */
function legacyCheck(id: number, reviewId = request.reviewId) {
  return {
    id,
    name: checkName,
    app: { id: 1 },
    head_sha: headSha,
    external_id: `razbor/10/7/${baseSha}/${reviewId}`,
    status: "in_progress",
    conclusion: null as string | null,
  };
}

/** Supply only the reads and the cancellation PATCH needed for legacy GitHub reconciliation. */
function githubFixture(t: TestContext) {
  const pr = {
    number: 7,
    state: "OPEN",
    headRefOid: headSha,
    baseRefOid: baseSha,
    baseRefName: "main",
    autoMergeRequest: null as null | {
      enabledBy: { databaseId: number };
      mergeMethod: string;
    },
  };
  const repo = {
    databaseId: 10,
    defaultBranchRef: { name: "main" },
    pullRequest: pr,
  };
  const runs: ReturnType<typeof legacyCheck>[] = [];
  const mutations: string[] = [];
  const flags = {
    suiteCount: 1,
    truncated: false,
    loseRetireResponse: false,
    rejection: undefined as Response | undefined,
  };
  fakeFetch(t, (path, method, body) => {
    if (path === "/api/graphql" && String(body.query).startsWith("query "))
      return { data: { repository: repo } };
    const route = "/api/v3/repos/team/project";
    if (method === "GET" && path === route) return { id: repo.databaseId };
    if (
      method === "GET" &&
      path.startsWith(`${route}/commits/${headSha}/check-runs?`)
    ) {
      const params = new URLSearchParams(path.split("?")[1]);
      assert.equal(params.get("filter"), "all");
      assert.equal(params.get("app_id"), "1");
      assert.equal(params.get("per_page"), "100");
      const found = runs.filter(
        (r) => r.name === params.get("check_name") && r.app.id === 1,
      );
      const offset = (Number(params.get("page")) - 1) * 100;
      return {
        total_count: found.length,
        check_runs:
          flags.truncated && offset ? [] : found.slice(offset, offset + 100),
      };
    }
    if (
      method === "GET" &&
      path === `${route}/commits/${headSha}/check-suites?per_page=1`
    )
      return {
        total_count: flags.suiteCount,
        check_suites: [{ head_sha: headSha }],
      };
    const gate = runs.find((run) => path === `${route}/check-runs/${run.id}`);
    if (gate && method === "PATCH" && body.conclusion === "cancelled") {
      mutations.push(`cancel ${gate.id}`);
      if (flags.rejection) return flags.rejection;
      Object.assign(gate, body);
      if (flags.loseRetireResponse)
        throw new Error("cancellation acknowledgement lost");
      return gate;
    }
    mutations.push(`${method} ${path}`);
    assert.fail(
      "legacy reconciliation attempted an unexpected provider operation",
    );
  });
  return { api: forge("github"), repo, pr, runs, mutations, flags };
}

test("GitHub refuses every fresh native schedule and never releases an old gate on resume", async (t) => {
  const f = githubFixture(t);
  assert.deepEqual(await f.api.inspectMerge(request), {
    state: "blocked",
    reason: "github_schedule_owner_unbound",
  });
  for (const stage of [
    undefined,
    "prepared",
    "creating_check",
    "submitting",
    "armed",
    "releasing",
    "acknowledged",
  ] as const) {
    for (const resume of [true, false]) {
      const checkpoint = t.mock.fn(async () => {});
      await assert.rejects(
        f.api.scheduleMerge(
          { ...request, writeStage: stage },
          resume,
          checkpoint,
        ),
        (e) =>
          e instanceof ForgeOperationError &&
          e.reason === "unsupported" &&
          !e.uncertain,
      );
      assert.equal(checkpoint.mock.callCount(), 0);
    }
  }
  f.runs.push(legacyCheck(22));
  const saved = { ...request, writeStage: "armed" as const };
  f.pr.autoMergeRequest = {
    enabledBy: { databaseId: 2 },
    mergeMethod: "SQUASH",
  };
  const armed = await f.api.inspectMerge(saved);
  assert.equal(armed.nativeArmed, true);
  assert.equal(armed.state, "blocked");
  // A writer replaces the schedule after the read. A restarted dispatcher cannot release the old check.
  f.pr.autoMergeRequest = {
    enabledBy: { databaseId: 9 },
    mergeMethod: "MERGE",
  };
  assert.equal((await f.api.inspectMerge(saved)).nativeArmed, undefined);
  await assert.rejects(
    forge("github").scheduleMerge(saved, true),
    ForgeOperationError,
  );
  assert.equal(f.runs[0].status, "in_progress");
  assert.deepEqual(f.mutations, []);
});

test("GitHub reconciles a terminal PR against the saved repository, PR, branch and commit", async (t) => {
  const f = githubFixture(t);
  f.pr.state = "MERGED";
  assert.equal((await f.api.inspectMerge(request)).state, "merged");
  f.repo.databaseId = 11;
  assert.equal((await f.api.inspectMerge(request)).state, "stale");
  f.repo.databaseId = 10;
  f.pr.number = 8;
  assert.equal((await f.api.inspectMerge(request)).state, "stale");
  f.pr.number = 7;
  f.pr.headRefOid = baseSha;
  assert.equal((await f.api.inspectMerge(request)).terminal, true);
  f.pr.headRefOid = headSha;
  f.pr.baseRefName = "feature";
  assert.equal((await f.api.inspectMerge(request)).terminal, true);
  f.pr.baseRefName = "main";
  f.pr.state = "OPEN";
  f.pr.baseRefOid = headSha;
  assert.equal((await f.api.inspectMerge(request)).state, "stale");
  assert.deepEqual(f.mutations, []);
});

test("GitHub identifies an exact legacy orphan and retires it after a lost acknowledgement without scheduling", async (t) => {
  const f = githubFixture(t);
  const creating = { ...request, writeStage: "creating_check" as const };
  const next = { ...request, reviewId: "rev_abcdefghijklmnop" };
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  const gate = legacyCheck(24);
  f.runs.push(gate);
  assert.equal(
    (await f.api.inspectMerge(next)).pendingCheckReviewId,
    request.reviewId,
  );
  const owner = gate.external_id;
  gate.external_id = owner.replace("/7/", "/8/");
  assert.equal(
    (await f.api.inspectMerge(next)).pendingCheckReviewId,
    undefined,
  );
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  gate.external_id = owner;
  gate.app.id = 2;
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  gate.app.id = 1;
  f.pr.autoMergeRequest = {
    enabledBy: { databaseId: 9 },
    mergeMethod: "SQUASH",
  };
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  f.pr.autoMergeRequest = null;
  f.flags.loseRetireResponse = true;
  await assert.rejects(f.api.cancelMerge(creating), ForgeOperationError);
  f.flags.loseRetireResponse = false;
  assert.equal(await forge("github").cancelMerge(creating), "cancelled");
  assert.equal(gate.name, "Razbor / retired merge eligibility");
  assert.equal(gate.conclusion, "cancelled");
  assert.equal(
    (await f.api.inspectMerge(next)).pendingCheckReviewId,
    undefined,
  );
  await assert.rejects(f.api.scheduleMerge(next), ForgeOperationError);
  assert.deepEqual(f.mutations, ["cancel 24"]);
});

test("GitHub verifies all legacy check pages before retiring the exact operation", async (t) => {
  const f = githubFixture(t);
  f.runs.push(
    ...Array.from({ length: 101 }, (_, i) =>
      legacyCheck(i + 1, "rev_abcdefghijklmnop"),
    ),
    legacyCheck(102),
  );
  const saved = { ...request, writeStage: "acknowledged" as const };
  f.flags.truncated = true;
  await assert.rejects(f.api.cancelMerge(saved), ForgeOperationError);
  f.flags.truncated = false;
  f.flags.suiteCount = 1001;
  await assert.rejects(f.api.cancelMerge(saved), ForgeOperationError);
  f.flags.suiteCount = 1;
  assert.deepEqual(f.mutations, []);
  assert.equal(await f.api.cancelMerge(saved), "cancelled");
  assert.deepEqual(f.mutations, ["cancel 102"]);
  assert.equal(f.runs[0].conclusion, null);
});

test("GitHub distinguishes a confirmed legacy release from an uncertain release and preserves native ownership", async (t) => {
  const f = githubFixture(t);
  const saved = { ...request, writeStage: "releasing" as const };
  const gate = legacyCheck(25);
  f.runs.push(gate);
  f.pr.autoMergeRequest = {
    enabledBy: { databaseId: 2 },
    mergeMethod: "SQUASH",
  };
  assert.equal((await f.api.inspectMerge(saved)).state, "blocked");
  Object.assign(gate, { status: "completed", conclusion: "success" });
  assert.equal((await f.api.inspectMerge(saved)).state, "scheduled");
  f.pr.autoMergeRequest.enabledBy.databaseId = 9;
  assert.equal((await f.api.inspectMerge(saved)).nativeArmed, undefined);
  assert.equal(await f.api.cancelMerge(saved), "unsupported");
  assert.equal(f.pr.autoMergeRequest.enabledBy.databaseId, 9);
  f.pr.autoMergeRequest = null;
  assert.equal(await f.api.cancelMerge(saved), "cancelled");
  assert.deepEqual(f.mutations, ["cancel 25"]);
});

test("GitHub surfaces confirmed rate limits on legacy cancellation and preserves the check for retry", async (t) => {
  const f = githubFixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.runs.push(legacyCheck(26));
  f.flags.rejection = Response.json(
    { message: "You have exceeded a secondary rate limit." },
    { status: 403, headers: { "Retry-After": "120" } },
  );
  await assert.rejects(
    f.api.cancelMerge(request),
    (e) =>
      e instanceof ForgeOperationError &&
      !e.uncertain &&
      e.retryAt === now + 120000,
  );
  assert.equal(f.runs[0].conclusion, null);
  f.flags.rejection = undefined;
  assert.equal(await f.api.cancelMerge(request), "cancelled");
  assert.deepEqual(f.mutations, ["cancel 26", "cancel 26"]);
});

/** Return authoritative pipeline, protection, schedule owner and revision state from an offline MR. */
function gitlabFixture(t: TestContext) {
  const mr = {
    iid: 7,
    project_id: 10,
    state: "opened",
    sha: headSha,
    target_branch: "main",
    draft: false,
    squash_on_merge: false as boolean | undefined,
    squash_commit_sha: null as string | null | undefined,
    merge_when_pipeline_succeeds: false,
    merge_user: null as null | { id: number },
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    blocking_discussions_resolved: true,
    head_pipeline: { sha: headSha, status: "success" },
  };
  const project = {
    id: 10,
    default_branch: "main",
    merge_method: "rebase_merge",
    squash_option: "default_on",
    only_allow_merge_if_pipeline_succeeds: true,
    allow_merge_on_skipped_pipeline: false,
    automatic_rebase_enabled: false as boolean | undefined,
    merge_trains_enabled: false,
    permissions: { project_access: { access_level: 30 }, group_access: null },
  };
  const flags = {
    loseResponse: false,
    refuse: false,
    nullMergeUser: false,
    base: baseSha,
    version: "19.4.0-ee",
  };
  const mutations: Record<string, unknown>[] = [];
  fakeFetch(t, (path, method, body) => {
    const route = "/api/v4/projects/team%2Fproject";
    if (path === route) return project;
    if (path === route + "/merge_requests/7") return mr;
    if (path === "/api/v4/user") return { id: 2, bot: true };
    if (path === "/api/v4/version") return { version: flags.version };
    if (path.startsWith(route + "/protected_branches?"))
      return path.endsWith("page=1")
        ? ["*", "main"].map((name) => ({
            name,
            allow_force_push: false,
            push_access_levels: [{ access_level: 0 }],
            merge_access_levels: [{ access_level: name === "main" ? 30 : 40 }],
          }))
        : [];
    if (path === route + "/repository/branches/main")
      return { name: "main", protected: true, commit: { id: flags.base } };
    if (path === route + "/repository/commits/" + headSha)
      return { id: headSha, parent_ids: [baseSha] };
    if (
      path === "/api/v4/projects/10/merge_requests/7/merge" &&
      method === "PUT"
    ) {
      mutations.push(body);
      if (flags.refuse) return new Response(null, { status: 409 });
      mr.merge_when_pipeline_succeeds = true;
      mr.merge_user = flags.nullMergeUser ? null : { id: 2 };
      if (flags.loseResponse) throw new Error("response lost");
      return mr;
    }
    assert.fail(`unexpected ${method} ${path}`);
  });
  return { api: forge("gitlab"), mr, project, flags, mutations };
}

test("GitLab verifies a same-SHA successful pipeline and native restrictions before scheduling by numeric project ID and SHA", async (t) => {
  const f = gitlabFixture(t);
  f.mr.head_pipeline.status = "running";
  assert.equal((await f.api.inspectMerge(request)).state, "awaiting_checks");
  f.mr.head_pipeline.status = "success";
  for (const status of [
    "checking",
    "unchecked",
    "preparing",
    "ci_still_running",
    "approvals_syncing",
  ]) {
    f.mr.detailed_merge_status = status;
    assert.equal((await f.api.inspectMerge(request)).state, "awaiting_checks");
  }
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  assert.equal(
    (await f.api.inspectMerge({ ...request, baseSha: headSha })).state,
    "stale",
  );
  f.mr.detailed_merge_status = "not_approved";
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
  f.mr.detailed_merge_status = "mergeable";
  f.mr.blocking_discussions_resolved = false;
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
  f.mr.blocking_discussions_resolved = true;
  for (const [version, absentState] of [
    ["17.11.7-ee", "ready"],
    ["18.11.2-ee", "blocked"],
    ["19.4.0-ee", "blocked"],
  ] as const) {
    f.flags.version = version;
    if (version === "19.4.0-ee") {
      f.project.automatic_rebase_enabled = true;
      assert.equal((await f.api.inspectMerge(request)).state, "blocked");
    }
    f.project.automatic_rebase_enabled = undefined;
    assert.equal((await f.api.inspectMerge(request)).state, absentState);
  }
  f.project.automatic_rebase_enabled = false;
  f.flags.base = "c".repeat(40);
  assert.equal((await f.api.inspectMerge(request)).state, "stale");
  f.flags.base = baseSha;
  assert.equal((await f.api.inspectMerge(request)).state, "ready");
  assert.deepEqual(f.mutations, []);
  assert.equal(await f.api.scheduleMerge(request), "scheduled");
  assert.deepEqual(f.mutations, [
    { sha: headSha, auto_merge: true, squash: true },
  ]);
  f.mr.merge_user = { id: 3 };
  assert.equal((await f.api.inspectMerge(request)).reason, "existing_schedule");
  assert.equal(await f.api.cancelMerge(request), "unsupported");
  assert.equal(f.mutations.length, 1);
});

test("GitLab requires project-enforced unsquashed merges and checks the terminal result", async (t) => {
  const f = gitlabFixture(t);
  const unsquashed = { ...request, method: "merge" as const };
  f.flags.version = "17.11.7-ee";
  f.project.automatic_rebase_enabled = undefined;
  f.mr.squash_on_merge = true;
  assert.equal(
    (await f.api.inspectMerge(unsquashed)).reason,
    "merge_method_unavailable",
  );
  await assert.rejects(f.api.scheduleMerge(unsquashed), ForgeOperationError);
  f.mr.squash_on_merge = false;
  assert.equal(
    (await f.api.inspectMerge(unsquashed)).reason,
    "merge_method_unavailable",
  );
  f.project.squash_option = "never";
  f.mr.squash_on_merge = undefined;
  assert.equal(
    (await f.api.inspectMerge(unsquashed)).reason,
    "merge_method_unavailable",
  );
  assert.deepEqual(f.mutations, []);
  f.mr.squash_on_merge = false;
  assert.equal(await f.api.scheduleMerge(unsquashed), "scheduled");
  f.mr.state = "merged";
  f.mr.squash_commit_sha = headSha;
  assert.equal(
    (await f.api.inspectMerge(unsquashed)).reason,
    "merge_method_unavailable",
  );
  f.mr.squash_commit_sha = null;
  assert.equal((await f.api.inspectMerge(unsquashed)).state, "merged");
});

test("GitLab distinguishes a guarded refusal from an unknown outcome and reconciles the latter by reading", async (t) => {
  const f = gitlabFixture(t);
  f.flags.refuse = true;
  await assert.rejects(
    f.api.scheduleMerge(request),
    (e) => e instanceof ForgeOperationError && !e.uncertain && e.status === 409,
  );
  f.flags.refuse = false;
  f.flags.loseResponse = true;
  await assert.rejects(
    f.api.scheduleMerge(request),
    (e) => e instanceof ForgeOperationError && e.uncertain,
  );
  assert.equal(
    (await forge("gitlab").inspectMerge(request)).state,
    "scheduled",
  );
  assert.equal(f.mutations.length, 2);
});

test("GitLab binds an unattributed schedule to a positive PUT receipt and preserves uncertainty after transport loss", async (t) => {
  const f = gitlabFixture(t);
  const stages: ForgeMergeWriteStage[] = [];
  f.flags.nullMergeUser = true;
  assert.equal(
    await f.api.scheduleMerge(request, false, async (stage) => {
      stages.push(stage);
    }),
    "scheduled",
  );
  assert.deepEqual(stages, ["submitting", "acknowledged"]);
  assert.equal((await f.api.inspectMerge(request)).reason, "existing_schedule");
  assert.equal(
    (await f.api.inspectMerge({ ...request, writeStage: "acknowledged" }))
      .state,
    "scheduled",
  );
  f.mr.merge_user = { id: 3 };
  assert.equal(
    (await f.api.inspectMerge({ ...request, writeStage: "acknowledged" }))
      .reason,
    "existing_schedule",
  );
  f.mr.merge_when_pipeline_succeeds = false;
  f.flags.loseResponse = true;
  stages.length = 0;
  await assert.rejects(
    f.api.scheduleMerge(request, false, async (stage) => {
      stages.push(stage);
    }),
  );
  assert.deepEqual(stages, ["submitting"]);
  assert.equal(
    (await f.api.inspectMerge({ ...request, writeStage: "submitting" })).reason,
    "existing_schedule",
  );
  f.mr.sha = "c".repeat(40);
  f.mr.state = "merged";
  assert.equal((await f.api.inspectMerge(request)).terminal, true);
  f.mr.project_id = 99;
  assert.equal((await f.api.inspectMerge(request)).terminal, undefined);
});

test("Forgejo reports an unsupported unpinned native scheduler; no merge call can escape the guard", async (t) => {
  const methods: string[] = [];
  fakeFetch(t, (_path, method) => {
    methods.push(method);
    assert.equal(method, "GET");
    return {
      number: 7,
      merged: false,
      state: "open",
      head: { sha: headSha },
      base: { sha: baseSha, ref: "main", repo_id: 10 },
    };
  });
  const api = forge("forgejo");
  assert.equal(
    (await api.inspectMerge(request)).reason,
    "forgejo_schedule_does_not_pin_reviewed_head",
  );
  await assert.rejects(api.scheduleMerge(request), ForgeOperationError);
  assert.match(
    forgeMergeReason("forgejo_schedule_does_not_pin_reviewed_head"),
    /discards the reviewed head SHA/,
  );
  assert.doesNotMatch(forgeMergeReason("<remote payload>"), /payload/);
  assert.deepEqual(methods, ["GET"]);
});

test("reviewer lookup uses an exact provider user and suppresses mass, missing, inactive or non-user names", async (t) => {
  const queried: string[] = [];
  const longLogin = "r".repeat(64);
  fakeFetch(t, (path, method) => {
    assert.equal(method, "GET");
    queried.push(path);
    if (path === "/api/v3/users/maintainers")
      return { login: "maintainers", type: "Organization" };
    if (path === `/api/v4/users?username=${longLogin}&humans=true&active=true`)
      return [{ username: longLogin, state: "active", bot: false }];
    if (path === "/api/v4/users?username=Alice&humans=true&active=true")
      return [{ username: "alice", state: "active", bot: false }];
    if (path === "/api/v1/users/retired")
      return { id: 2, login: "retired", prohibit_login: true };
    if (path === "/api/v1/users/person")
      return { id: 4, login: "person", active: false };
    if (path === "/api/v1/users/search?uid=4&limit=1")
      return { ok: true, data: [{ id: 4, login: "person" }] };
    return new Response(null, { status: 404 });
  });
  assert.equal(await forge("gitlab").reviewerLogin("all"), null);
  assert.equal(queried.length, 0);
  assert.equal(await forge("gitlab").reviewerLogin(longLogin), longLogin);
  assert.equal(await forge("gitlab").reviewerLogin("Alice"), "alice");
  assert.equal(await forge("github").reviewerLogin("maintainers"), null);
  assert.equal(await forge("forgejo").reviewerLogin("retired"), null);
  assert.equal(await forge("forgejo").reviewerLogin("person"), "person");
  assert.equal(await forge("github").reviewerLogin("nobody"), null);
});

test("GitHub App source credentials carry read-only contents and discovery only metadata", async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentials = {
    appId: "1",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const connection = {
    type: "github" as const,
    apiUrl: "https://fixture.invalid/api/v3",
    webUrl: "https://fixture.invalid",
    allowHttp: false,
  };
  const requests: Record<string, unknown>[] = [];
  let excessive = false;
  fakeFetch(t, (path, method, body) => {
    if (path === "/api/v3/app/installations/3")
      return {
        id: 3,
        app_id: 1,
        account: { id: 20, login: "team" },
        suspended_at: null,
      };
    if (
      path === "/api/v3/app/installations/3/access_tokens" &&
      method === "POST"
    ) {
      requests.push(body);
      return {
        token: "local-only",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: excessive
          ? { contents: "write", checks: "write" }
          : body.permissions,
      };
    }
    if (path.startsWith("/api/v3/installation/repositories?"))
      return { repositories: [] };
    assert.fail(`unexpected ${method} ${path}`);
  });
  await createGithubInstallationToken(
    connection,
    credentials,
    "3",
    "10",
    "source",
  );
  await listGithubInstallationRepositories(connection, credentials, "3");
  await createGithubInstallationToken(connection, credentials, "3", "10");
  assert.deepEqual(requests, [
    { repository_ids: [10], permissions: { contents: "read" } },
    { permissions: { metadata: "read" } },
    { repository_ids: [10] },
  ]);
  excessive = true;
  await assert.rejects(
    createGithubInstallationToken(connection, credentials, "3", "10", "source"),
    ForgeOperationError,
  );
});

const approvalBot = { id: "2", login: "razbor[bot]" };

test("GitHub approves a pinned revision separately from merge, reconciles the exact vote and respects a dismissal", async (t) => {
  const api = forge("github");
  const votes: {
    id: string;
    state: string;
    body: string;
    commit: { oid: string };
    author: { databaseId: number };
    pullRequest: { id: string };
  }[] = [];
  const pr = {
    id: "NODE7",
    number: 7,
    state: "OPEN",
    isDraft: false,
    author: { login: "alice" },
    headRepository: { databaseId: 10 },
    headRef: { branchProtectionRule: null },
    headRefOid: headSha,
    baseRefOid: baseSha,
    baseRefName: "main",
    isInMergeQueue: false,
    autoMergeRequest: null as null | { enabledAt: string },
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    commits: {
      nodes: [
        {
          commit: {
            oid: headSha,
            status: { contexts: [{ context: "legacy", state: "SUCCESS" }] },
          },
        },
      ],
    },
    baseRef: {
      refUpdateRule: { viewerAllowedToDismissReviews: true },
      branchProtectionRule: {
        isAdminEnforced: true,
        requiresApprovingReviews: true,
        dismissesStaleReviews: true,
        requiredStatusChecks: [
          { context: checkName, app: { databaseId: 1 } },
          { context: "legacy", app: null },
        ],
      },
    },
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [{ isResolved: true }],
    },
    latestOpinionatedReviews: {
      pageInfo: { hasNextPage: false },
      nodes: [{ state: "COMMENTED" }],
    },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: votes },
  };
  let enforcedRuleset = false;
  let bypass = "never";
  let loseResponse = false;
  let checkpoints = 0;
  let pendingApp = 1;
  let optionalConclusion = "skipped";
  const mutations: string[] = [];
  fakeFetch(t, (path, method, body) => {
    if (path === "/api/graphql") {
      if (String(body.query).includes("query RazborApproval")) {
        assert.match(String(body.query), /dismissesStaleReviews/);
        assert.match(String(body.query), /reviewThreads/);
        return {
          data: {
            repository: {
              databaseId: 10,
              defaultBranchRef: { name: "main" },
              pullRequest: pr,
            },
          },
        };
      }
      if (String(body.query).includes("query RazborRetireApproval")) {
        const after = (body.variables as Record<string, unknown>).after;
        assert.ok(after === null || after === "NEXT");
        return {
          data: {
            repository: {
              databaseId: 10,
              pullRequest: {
                ...pr,
                reviews: {
                  pageInfo: {
                    hasNextPage: after === null,
                    endCursor: after === null ? "NEXT" : null,
                  },
                  nodes: after === null ? [] : votes,
                },
              },
            },
          },
        };
      }
      if (String(body.query).includes("mutation RazborDismissApproval")) {
        assert.equal(
          (body.variables as Record<string, string>).id,
          "VOTE_NODE",
        );
        assert.equal(checkpoints, mutations.length + 1);
        mutations.push("dismiss");
        votes[0].state = "DISMISSED";
        if (loseResponse) throw new Error("lost dismissal response");
        return {
          data: { dismissPullRequestReview: { pullRequestReview: votes[0] } },
        };
      }
      assert.match(
        String(body.query),
        /addPullRequestReview\(input:\{pullRequestId:\$pull,commitOID:\$head,event:APPROVE/,
      );
      const variables = body.variables as Record<string, string>;
      assert.equal(variables.head, headSha);
      assert.equal(variables.pull, pr.id);
      assert.equal(checkpoints, mutations.length + 1);
      mutations.push("approval");
      const review = {
        id: "VOTE_NODE",
        state: "APPROVED",
        body: variables.body,
        commit: { oid: headSha },
        author: { databaseId: 2 },
        pullRequest: { id: pr.id },
      };
      votes.push(review);
      if (loseResponse) throw new Error("lost");
      return { data: { addPullRequestReview: { pullRequestReview: review } } };
    }
    assert.equal(method, "GET");
    if (path.includes("/rules/branches/main?"))
      return enforcedRuleset
        ? [
            {
              type: "pull_request",
              ruleset_id: 12,
              parameters: { dismiss_stale_reviews_on_push: true },
            },
          ]
        : [];
    if (path.endsWith("/rulesets/12"))
      return {
        id: 12,
        target: "branch",
        enforcement: "active",
        current_user_can_bypass: bypass,
      };
    if (path.includes("/check-runs?"))
      return {
        total_count: 2,
        check_runs: [
          {
            id: 4,
            name: checkName,
            app: { id: pendingApp },
            head_sha: headSha,
            external_id: null,
            status: "in_progress",
            conclusion: null,
          },
          {
            id: 5,
            name: "Optional",
            app: { id: 5 },
            head_sha: headSha,
            external_id: null,
            status: "completed",
            conclusion: optionalConclusion,
          },
        ],
      };
    if (path.includes("/check-suites?"))
      return { total_count: 1, check_suites: [{ head_sha: headSha }] };
    throw new Error(path);
  });
  /** Count commits of the first-write fence before the simulated review reaches GitHub. */
  async function checkpoint() {
    checkpoints++;
  }
  pr.baseRef.refUpdateRule.viewerAllowedToDismissReviews = false;
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "unsupported",
  );
  pr.baseRef.refUpdateRule.viewerAllowedToDismissReviews = true;
  assert.equal(
    await api.retireApproval(request, approvalBot, false, checkpoint),
    "unconfirmed",
  );
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "ready",
  );
  pr.mergeable = "UNKNOWN";
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "awaiting_checks",
  );
  pr.mergeable = "MERGEABLE";
  optionalConclusion = "neutral";
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "ready",
  );
  pr.isInMergeQueue = true;
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "unsupported",
  );
  pr.isInMergeQueue = false;
  pr.autoMergeRequest = { enabledAt: "2026-01-01" };
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "existing_schedule",
  );
  pr.autoMergeRequest = null;
  pr.author.login = approvalBot.login;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_actor_unavailable",
  );
  pr.author.login = "alice";
  pr.baseRef.branchProtectionRule.dismissesStaleReviews = false;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_unsupported",
  );
  enforcedRuleset = true;
  bypass = "always";
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_unsupported",
  );
  bypass = "never";
  pr.reviewThreads.nodes[0].isResolved = false;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "blocked",
  );
  pr.reviewThreads.nodes[0].isResolved = true;
  pr.latestOpinionatedReviews.nodes[0].state = "CHANGES_REQUESTED";
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "blocked",
  );
  pr.latestOpinionatedReviews.nodes[0].state = "COMMENTED";
  pr.commits.nodes[0].commit.status.contexts[0].state = "FAILURE";
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "required_check_failed",
  );
  pr.commits.nodes[0].commit.status.contexts[0].state = "SUCCESS";
  pendingApp = 3;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "required_check_pending",
  );
  pendingApp = 1;
  assert.equal(
    await api.approveReview(
      { ...request, headSha: baseSha },
      approvalBot,
      false,
      checkpoint,
    ),
    "stale",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint),
    "absent",
  );
  assert.equal(checkpoints, 0);
  loseResponse = true;
  await assert.rejects(
    api.approveReview(request, approvalBot, false, checkpoint),
    { uncertain: true },
  );
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint),
    "approved",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "approved",
  );
  pr.autoMergeRequest = { enabledAt: "2026-01-01" };
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint, true),
    "approved",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "unsupported",
  );
  votes[0].state = "DISMISSED";
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint, true),
    "dismissed",
  );
  pr.autoMergeRequest = null;
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "dismissed",
  );
  // A marked review remains addressable after either ref changes and after closure.
  votes[0].state = "APPROVED";
  pr.state = "CLOSED";
  pr.headRefOid = baseSha;
  pr.baseRefName = "retargeted";
  votes.push({ ...votes[0], id: "OTHER", body: "a separate review" });
  assert.equal(
    await api.retireApproval(
      { ...request, externalRepositoryId: "11" },
      approvalBot,
      true,
      checkpoint,
    ),
    "unconfirmed",
  );
  await assert.rejects(
    api.retireApproval(request, approvalBot, false, checkpoint),
    { uncertain: true },
  );
  assert.equal(
    await api.retireApproval(request, approvalBot, false, checkpoint, true),
    "retired",
  );
  assert.equal(votes[1].state, "APPROVED");
  assert.deepEqual(mutations, ["approval", "dismiss"]);
  votes.shift();
  assert.equal(
    await api.retireApproval(request, approvalBot, true, checkpoint),
    "unconfirmed",
  );
  pr.state = "MERGED";
  assert.equal(
    await api.retireApproval(request, approvalBot, false, checkpoint, true),
    "retired",
  );
});

test("GitLab approval uses the numeric MR and SHA guard and requires revision-bound evidence to recover", async (t) => {
  const api = forge("gitlab");
  const mr = {
    iid: 7,
    project_id: 10,
    state: "opened",
    draft: false,
    sha: headSha,
    target_branch: "main",
    author: { id: 9 },
    diff_refs: { head_sha: headSha },
    head_pipeline: { sha: headSha, status: "success" },
    merge_when_pipeline_succeeds: false,
    has_conflicts: false,
    detailed_merge_status: "not_approved",
    blocking_discussions_resolved: true,
  };
  const project = {
    id: 10,
    default_branch: "main",
    merge_trains_enabled: false as boolean | undefined,
  };
  const approvals = {
    project_id: 10,
    iid: 7,
    user_can_approve: true,
    approved_by: [] as { user: { id: number } }[],
  };
  const settings = {
    reset_approvals_on_push: true,
    selective_code_owner_removals: false,
  };
  let requestedChanges = false;
  let loseResponse = false;
  let wrongReceipt = false;
  let writes = 0;
  let withdrawalWrites = 0;
  let actorId = 2;
  let fences = 0;
  /** Record each durable intent, which must precede exactly one GitLab POST. */
  async function checkpoint() {
    fences++;
  }
  fakeFetch(t, (path, method, body) => {
    const mrPath = "/api/v4/projects/10/merge_requests/7";
    if (method === "POST") {
      if (path === mrPath + "/unapprove") {
        assert.equal(fences, writes + ++withdrawalWrites);
        assert.deepEqual(body, {});
        approvals.approved_by = approvals.approved_by.filter(
          ({ user }) => user.id !== actorId,
        );
        if (loseResponse) throw new Error("lost withdrawal");
        return approvals;
      }
      assert.equal(path, mrPath + "/approve");
      assert.deepEqual(body, { sha: headSha });
      assert.equal(fences, ++writes);
      approvals.approved_by = [{ user: { id: 2 } }];
      if (loseResponse) throw new Error("response lost");
      return wrongReceipt ? { ...approvals, iid: 8 } : approvals;
    }
    if (path === "/api/v4/projects/team%2Fproject") return project;
    if (path === "/api/v4/user") return { id: actorId, bot: true };
    if (path === "/api/v4/projects/10/approvals") return settings;
    if (path === "/api/v4/projects/10/repository/branches/main")
      return { name: "main", commit: { id: baseSha } };
    if (path === mrPath) return mr;
    if (path === mrPath + "/approvals") return approvals;
    if (path === mrPath + "/reviewers?per_page=50&page=1")
      return [{ state: "unreviewed" }];
    if (path === mrPath + "/reviewers?per_page=50&page=2" && requestedChanges)
      return [{ state: "requested_changes" }];
    if (path.includes(mrPath + "/reviewers?")) return [];
    throw new Error(path);
  });
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "ready",
  );
  project.merge_trains_enabled = undefined;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_unsupported",
  );
  project.merge_trains_enabled = true;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "existing_schedule",
  );
  project.merge_trains_enabled = false;
  mr.merge_when_pipeline_succeeds = true;
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "unsupported",
  );
  mr.merge_when_pipeline_succeeds = false;
  mr.author.id = 2;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_actor_unavailable",
  );
  mr.author.id = 9;
  requestedChanges = true;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).state,
    "blocked",
  );
  requestedChanges = false;
  settings.reset_approvals_on_push = false;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_unsupported",
  );
  settings.reset_approvals_on_push = true;
  settings.selective_code_owner_removals = true;
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_unsupported",
  );
  settings.selective_code_owner_removals = false;
  for (const state of ["approvals_syncing", "ci_still_running", "checking"]) {
    mr.detailed_merge_status = state;
    assert.equal(
      (await api.inspectApproval(request, approvalBot)).state,
      "awaiting_checks",
    );
  }
  mr.detailed_merge_status = "not_approved";
  mr.head_pipeline.status = "failed";
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "pipeline_failed",
  );
  mr.head_pipeline.status = "success";
  assert.equal(
    await api.approveReview(
      { ...request, baseSha: headSha },
      approvalBot,
      false,
      checkpoint,
    ),
    "stale",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint),
    "absent",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "approved",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint, true),
    "approved",
  );
  mr.merge_when_pipeline_succeeds = true;
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint, true),
    "approved",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "unsupported",
  );
  approvals.approved_by = [];
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint, true),
    "dismissed",
  );
  mr.merge_when_pipeline_succeeds = false;
  loseResponse = true;
  await assert.rejects(
    api.approveReview(request, approvalBot, false, checkpoint),
    { uncertain: true },
  );
  assert.equal(
    await api.approveReview(request, approvalBot, true, checkpoint),
    "absent",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, false, checkpoint),
    "unsupported",
  );
  assert.equal(writes, 2);
  loseResponse = false;
  approvals.approved_by = [];
  wrongReceipt = true;
  await assert.rejects(
    api.approveReview(request, approvalBot, false, checkpoint),
    { uncertain: true },
  );
  approvals.approved_by = [{ user: { id: 2 } }, { user: { id: 9 } }];
  assert.equal(
    await api.retireApproval(request, approvalBot, false, checkpoint),
    "unconfirmed",
  );
  mr.sha = baseSha;
  assert.equal(
    await api.retireApproval(request, approvalBot, true, checkpoint),
    "unconfirmed",
  );
  mr.sha = headSha;
  actorId = 4;
  assert.equal(
    await api.retireApproval(request, approvalBot, true, checkpoint),
    "unconfirmed",
  );
  actorId = 2;
  mr.target_branch = "retargeted";
  mr.state = "closed";
  assert.equal(
    await api.retireApproval(request, approvalBot, true, checkpoint),
    "retired",
  );
  assert.equal(
    await api.retireApproval(request, approvalBot, true, checkpoint),
    "retired",
  );
  assert.deepEqual(approvals.approved_by, [{ user: { id: 9 } }]);
  approvals.approved_by.push({ user: { id: 2 } });
  loseResponse = true;
  await assert.rejects(
    api.retireApproval(request, approvalBot, true, checkpoint),
    { uncertain: true },
  );
  assert.equal(
    await api.retireApproval(request, approvalBot, true, checkpoint, true),
    "unconfirmed",
  );
  mr.state = "merged";
  assert.equal(
    await api.retireApproval(request, approvalBot, false, checkpoint, true),
    "retired",
  );
  assert.equal(withdrawalWrites, 2);
});

test("Forgejo explicitly abstains from native approval when it cannot inspect an armed schedule", async (t) => {
  const api = forge("forgejo");
  fakeFetch(t, (path) => assert.fail(path));
  assert.equal(
    (await api.inspectApproval(request, approvalBot)).reason,
    "approval_unsupported",
  );
  assert.equal(
    await api.approveReview(request, approvalBot, false, async () =>
      assert.fail("unexpected approval intent"),
    ),
    "unsupported",
  );
  assert.equal(
    await api.retireApproval(request, approvalBot, true, async () =>
      assert.fail(),
    ),
    "unconfirmed",
  );
});
