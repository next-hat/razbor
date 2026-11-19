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

const locked = {
  pattern: "**/*",
  lockBranch: true,
  isAdminEnforced: true,
  lockAllowsFetchAndMerge: false,
  allowsDeletions: false,
  allowsForcePushes: false,
  restrictsPushes: false,
  pushAllowances: { pageInfo: { hasNextPage: false }, nodes: [] },
};

const checkName = "Razbor / merge eligibility";

/** Model the native App check separately from PR-specific auto-merge state to exercise recovery boundaries. */
function githubFixture(t: TestContext) {
  const pr = {
    id: "NODE7",
    number: 7,
    state: "OPEN",
    isDraft: false,
    headRefOid: headSha,
    headRepository: { databaseId: 10 },
    baseRefOid: baseSha,
    baseRefName: "main",
    viewerCanMergeAsAdmin: false,
    viewerCanEnableAutoMerge: true,
    reviewDecision: null as string | null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    mergeQueue: null,
    headRef: {
      branchProtectionRule: { ...locked },
      target: { oid: headSha, parents: { nodes: [{ oid: baseSha }] } },
    },
    baseRef: {
      branchProtectionRule: {
        pattern: "main",
        isAdminEnforced: true,
        allowsForcePushes: false,
        allowsDeletions: false,
        requiresStatusChecks: true,
        requiresConversationResolution: true as boolean | undefined,
        requiresStrictStatusChecks: true,
        requiredStatusChecks: [
          { context: checkName, app: { databaseId: 1 } },
          { context: "CI", app: { databaseId: 3 } },
        ],
      },
    },
    autoMergeRequest: null as null | {
      enabledBy: { databaseId: number };
      mergeMethod: string;
    },
  };
  const repo = {
    databaseId: 10,
    defaultBranchRef: { name: "main" },
    autoMergeAllowed: true,
    mergeCommitAllowed: true,
    rebaseMergeAllowed: true,
    squashMergeAllowed: true,
    pullRequests: {
      pageInfo: { hasNextPage: false },
      nodes: [{ number: 7, headRefOid: headSha }],
    },
    branchProtectionRules: {
      pageInfo: { hasNextPage: false },
      nodes: [structuredClone(locked)],
    },
    pullRequest: pr,
  };
  const runs = [
    {
      id: 1,
      name: "CI",
      app: { id: 3 },
      head_sha: headSha,
      external_id: "ci",
      status: "completed",
      conclusion: "success" as string | null,
    },
  ];
  const mutations: string[] = [];
  const flags = {
    rulesetBypass: "never",
    dedicatedGate: false,
    conversationRuleset: false,
    armResponse: undefined as Response | undefined,
    loseArmResponse: false,
    moveHeadOnArm: false,
    loseCreateResponse: false,
    loseRetireResponse: false,
    delayRelease: false,
    checkSuiteCount: 1,
    secondCheckPage: undefined as
      { total_count: number; check_runs: typeof runs } | undefined,
  };
  fakeFetch(t, (path, method, body) => {
    if (path === "/api/graphql" && String(body.query).startsWith("query ")) {
      if (String(body.query).includes("viewerCanEnableAutoMerge"))
        assert.match(
          String(body.query),
          /baseRef\s*\{\s*branchProtectionRule\s*\{[^{}]*\brequiresConversationResolution\b/,
        );
      return { data: { repository: repo } };
    }
    if (
      path === "/api/graphql" &&
      String(body.query).includes("enablePullRequestAutoMerge")
    ) {
      mutations.push("arm");
      assert.deepEqual(body.variables, {
        input: {
          pullRequestId: "NODE7",
          expectedHeadOid: headSha,
          mergeMethod: "SQUASH",
          clientMutationId: runs.at(-1)?.external_id.split("/").at(-1),
        },
      });
      assert.equal(runs.at(-1)?.status, "in_progress");
      if (flags.armResponse) return flags.armResponse;
      if (flags.moveHeadOnArm) {
        pr.headRefOid = "c".repeat(40);
        return { errors: [{ message: "head changed" }] };
      }
      pr.autoMergeRequest = {
        enabledBy: { databaseId: 2 },
        mergeMethod: "SQUASH",
      };
      if (flags.loseArmResponse) throw new Error("connection dropped");
      return {
        data: { enablePullRequestAutoMerge: { pullRequest: { id: pr.id } } },
      };
    }
    const route = "/api/v3/repos/team/project";
    if (path === route) return { id: 10 };
    if (path.startsWith(route + "/rules/branches/main?"))
      return [
        ...(flags.dedicatedGate
          ? [
              {
                type: "required_status_checks",
                ruleset_id: 70,
                parameters: {
                  required_status_checks: [
                    { context: checkName, integration_id: 1 },
                  ],
                },
              },
            ]
          : []),
        ...(flags.conversationRuleset
          ? [
              {
                type: "pull_request",
                ruleset_id: 70,
                parameters: { required_review_thread_resolution: true },
              },
            ]
          : []),
      ];
    if (path === route + "/rulesets/70")
      return {
        id: 70,
        target: "branch",
        enforcement: "active",
        current_user_can_bypass: flags.rulesetBypass,
      };
    if (path === `${route}/commits/${headSha}/check-suites?per_page=1`)
      return {
        total_count: flags.checkSuiteCount,
        check_suites: [{ head_sha: headSha }],
      };
    if (path.startsWith(`${route}/commits/${headSha}/check-runs?`)) {
      const params = new URLSearchParams(path.split("?")[1]);
      const page = Number(params.get("page") ?? 1);
      assert.equal(params.get("per_page"), "100");
      if (page === 2 && flags.secondCheckPage) return flags.secondCheckPage;
      let found = runs;
      if (params.get("filter") === "all") {
        assert.equal(params.get("app_id"), "1");
        found = runs.filter(
          (row) => row.app.id === 1 && row.name === params.get("check_name"),
        );
      }
      return {
        total_count: found.length,
        check_runs: found.slice((page - 1) * 100, page * 100),
      };
    }
    if (method === "POST" && path === `${route}/check-runs`) {
      mutations.push("create_pending");
      assert.equal(body.head_sha, headSha);
      assert.equal(body.status, "in_progress");
      const id = runs.length + 1;
      runs.push({
        id,
        name: String(body.name),
        app: { id: 1 },
        external_id: String(body.external_id),
        head_sha: headSha,
        status: String(body.status),
        conclusion: null,
      });
      if (flags.loseCreateResponse)
        throw new Error("check acknowledgement lost");
      return { id };
    }
    const run = runs.find((item) => path === `${route}/check-runs/${item.id}`);
    if (method === "PATCH" && run) {
      mutations.push(String(body.conclusion));
      if (body.conclusion === "success" && flags.delayRelease)
        throw new Error("eligibility release still in flight");
      Object.assign(run, body);
      if (
        body.name === "Razbor / retired merge eligibility" &&
        flags.loseRetireResponse
      )
        throw new Error("retirement acknowledgement lost");
      return run;
    }
    assert.fail(`unexpected ${method} ${path}`);
  });
  return { api: forge("github"), repo, pr, runs, mutations, flags };
}

test("GitHub checks the pinned App, all verified checks, protection and targets before arming the exact PR", async (t) => {
  const f = githubFixture(t);
  assert.equal((await f.api.inspectMerge(request)).state, "ready");
  assert.deepEqual(f.mutations, []);
  f.pr.baseRef.branchProtectionRule.requiredStatusChecks[0].app.databaseId = 99;
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
  f.pr.baseRef.branchProtectionRule.requiredStatusChecks[0].app.databaseId = 1;
  f.runs[0].conclusion = "failure";
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
  f.runs[0].conclusion = "success";
  f.pr.headRef.branchProtectionRule.lockBranch = false;
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  f.pr.headRef.branchProtectionRule.lockBranch = true;
  f.repo.branchProtectionRules.nodes[0].pattern = "release/*";
  assert.equal(
    (await f.api.inspectMerge(request)).reason,
    "exclusive_destination_required",
  );
  f.repo.branchProtectionRules.nodes[0].pattern = "**/*";
  assert.equal(
    (await f.api.inspectMerge({ ...request, baseBranch: "feature" })).state,
    "stale",
  );
  f.pr.reviewDecision = "REVIEW_REQUIRED";
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
  f.pr.reviewDecision = null;
  assert.deepEqual(f.mutations, []);
  assert.equal(await f.api.scheduleMerge(request), "scheduled");
  assert.deepEqual(f.mutations, ["create_pending", "arm", "success"]);
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  assert.equal(await f.api.cancelMerge(request), "unsupported");
  assert.equal(f.pr.autoMergeRequest?.enabledBy.databaseId, 2);
  f.pr.autoMergeRequest = null;
  assert.equal(await f.api.cancelMerge(request), "cancelled");
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
});

test("GitHub pages through required and historical checks and rejects inconsistent pages before a write", async (t) => {
  const f = githubFixture(t);
  const ci = f.runs[0];
  const background = Array.from({ length: 100 }, (_, i) => ({
    ...ci,
    id: 300 + i,
    name: `background-${i}`,
    app: { id: 1 },
    external_id: `background-${i}`,
  }));
  f.runs.unshift(...background);
  ci.conclusion = "failure";
  assert.equal(
    (await f.api.inspectMerge(request)).reason,
    "required_check_failed",
  );
  ci.conclusion = "success";
  for (const invalid of [
    { total_count: 101, check_runs: [background[0]] },
    { total_count: 101, check_runs: [{ ...ci, head_sha: baseSha }] },
    { total_count: 101, check_runs: [] },
    { total_count: 102, check_runs: [ci, { ...ci, id: 999 }] },
  ]) {
    f.flags.secondCheckPage = invalid;
    await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  }
  f.flags.secondCheckPage = undefined;
  f.flags.checkSuiteCount = 1001;
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  assert.deepEqual(f.mutations, []);
  f.flags.checkSuiteCount = 1000;
  f.runs.push(
    ...Array.from({ length: 1900 }, (_, i) => ({
      ...ci,
      id: 1000 + i,
      name: `extra-${i}`,
    })),
  );
  await assert.rejects(f.api.inspectMerge(request), ForgeOperationError);
  f.runs.pop();
  assert.equal((await f.api.inspectMerge(request)).state, "ready");
  f.runs.splice(101);
  assert.equal(await f.api.scheduleMerge(request), "scheduled");

  f.pr.autoMergeRequest = null;
  for (const other of background) other.name = checkName;
  f.flags.secondCheckPage = { total_count: 101, check_runs: [ci] };
  await assert.rejects(f.api.cancelMerge(request), ForgeOperationError);
  assert.equal(f.runs.at(-1)?.conclusion, "success");
  f.flags.secondCheckPage = undefined;
  assert.equal(await f.api.cancelMerge(request), "cancelled");
  assert.equal(f.runs.at(-1)?.conclusion, "cancelled");
  assert.ok(background.every((row) => row.conclusion === "success"));
  assert.deepEqual(f.mutations, [
    "create_pending",
    "arm",
    "success",
    "cancelled",
  ]);
});

test("GitHub retires only a verified pre-submission check and permits a replacement review on the same head", async (t) => {
  const f = githubFixture(t);
  const creating = { ...request, writeStage: "creating_check" as const };
  const next = { ...request, reviewId: "rev_abcdefghijklmnop" };
  f.flags.loseCreateResponse = true;
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  f.flags.loseCreateResponse = false;
  const gate = f.runs.pop()!;
  // Until the delayed check becomes visible its absence cannot retire or repeat the creation.
  assert.equal(
    (await f.api.inspectMerge(creating)).reason,
    "eligibility_check_unconfirmed",
  );
  await assert.rejects(
    f.api.scheduleMerge(creating, true),
    ForgeOperationError,
  );
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  f.runs.push(gate);
  assert.equal(
    (await f.api.inspectMerge(next)).reason,
    "conflicting_eligibility_check",
  );
  assert.equal(
    (await f.api.inspectMerge(next)).pendingCheckReviewId,
    request.reviewId,
  );
  const originalExternalId = gate.external_id;
  gate.external_id = gate.external_id.replace("/7/", "/8/");
  assert.equal(
    (await f.api.inspectMerge(next)).pendingCheckReviewId,
    undefined,
  );
  gate.external_id = originalExternalId;
  gate.status = "completed";
  gate.conclusion = "success";
  assert.equal(
    (await f.api.inspectMerge(next)).pendingCheckReviewId,
    undefined,
  );
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  assert.equal(
    (await f.api.inspectMerge(next)).reason,
    "conflicting_eligibility_check",
  );
  gate.conclusion = null;
  gate.status = "in_progress";
  gate.app.id = 3;
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  gate.app.id = 1;
  f.pr.autoMergeRequest = {
    enabledBy: { databaseId: 9 },
    mergeMethod: "SQUASH",
  };
  assert.equal(await f.api.cancelMerge(creating), "unsupported");
  f.pr.autoMergeRequest = null;
  assert.deepEqual(f.mutations, ["create_pending"]);
  const expectedExternalId = gate.external_id;
  // Older unrelated CI jobs must not exhaust the bound for the two eligibility names.
  f.runs.push(
    ...Array.from({ length: 105 }, (_, i) => ({
      ...f.runs[0],
      id: 50 + i,
      app: { id: 1 },
    })),
  );
  f.flags.loseRetireResponse = true;
  await assert.rejects(f.api.cancelMerge(creating), ForgeOperationError);
  f.flags.loseRetireResponse = false;
  assert.equal(await f.api.cancelMerge(creating), "cancelled");
  f.runs.splice(2, 105);
  assert.equal(gate.name, "Razbor / retired merge eligibility");
  assert.equal(gate.external_id, expectedExternalId);
  assert.equal(gate.conclusion, "cancelled");
  assert.equal(await f.api.cancelMerge(creating), "cancelled");
  assert.equal(
    (await f.api.inspectMerge(request)).reason,
    "retired_eligibility_check",
  );
  assert.equal((await f.api.inspectMerge(next)).state, "ready");
  assert.equal(await f.api.scheduleMerge(next), "scheduled");
  assert.deepEqual(f.mutations, [
    "create_pending",
    "cancelled",
    "create_pending",
    "arm",
    "success",
  ]);
  assert.equal(gate.conclusion, "cancelled");
});

test("GitHub waits for native conversation resolution on the default branch or an enforced ruleset", async (t) => {
  const f = githubFixture(t);
  f.pr.baseRef.branchProtectionRule.requiresConversationResolution = false;
  assert.equal(
    (await f.api.inspectMerge(request)).reason,
    "conversation_resolution_required",
  );
  f.pr.baseRef.branchProtectionRule.requiresConversationResolution = undefined;
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  f.flags.conversationRuleset = true;
  f.flags.rulesetBypass = "pull_requests_only";
  assert.equal(
    (await f.api.inspectMerge(request)).reason,
    "conversation_resolution_required",
  );
  f.flags.rulesetBypass = "never";
  assert.equal((await f.api.inspectMerge(request)).state, "ready");
  assert.deepEqual(f.mutations, []);
  await assert.rejects(
    f.api.scheduleMerge(request, false, async (stage) => {
      if (stage === "armed") f.flags.conversationRuleset = false;
    }),
    (error) => error instanceof ForgeOperationError && error.uncertain,
  );
  assert.deepEqual(f.mutations, ["create_pending", "arm"]);
  assert.equal(f.runs.at(-1)?.status, "in_progress");
});

test("GitHub restores a confirmed rate-limited native submission and preserves generic permission refusals", async (t) => {
  const f = githubFixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const stages: ForgeMergeWriteStage[] = [];
  /** Record the provider mutation boundaries in their durable order. */
  async function checkpoint(stage: ForgeMergeWriteStage) {
    stages.push(stage);
  }
  f.flags.armResponse = Response.json(
    { message: "You have exceeded a secondary rate limit." },
    { status: 403, headers: { "Retry-After": "120" } },
  );
  await assert.rejects(
    f.api.scheduleMerge(request, false, checkpoint),
    (e) =>
      e instanceof ForgeOperationError &&
      !e.uncertain &&
      e.retryAt === now + 120000,
  );
  assert.deepEqual(stages, ["creating_check", "submitting", "creating_check"]);
  const resume = { ...request, writeStage: "creating_check" as const };
  const reset = Math.ceil(now / 1000) + 300;
  f.flags.armResponse = new Response(null, {
    status: 429,
    headers: {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    },
  });
  await assert.rejects(
    f.api.scheduleMerge(resume, true, checkpoint),
    (e) =>
      e instanceof ForgeOperationError &&
      !e.uncertain &&
      e.retryAt === reset * 1000,
  );
  assert.deepEqual(stages.slice(-2), ["submitting", "creating_check"]);
  f.flags.armResponse = Response.json(
    { message: "Resource not accessible by integration" },
    { status: 403, headers: { "Retry-After": "120" } },
  );
  await assert.rejects(
    f.api.scheduleMerge(resume, true, checkpoint),
    (e) =>
      e instanceof ForgeOperationError &&
      e.status === 403 &&
      e.retryAt === undefined &&
      !e.uncertain,
  );
  assert.equal(stages.at(-1), "submitting");
  assert.equal(f.pr.autoMergeRequest, null);
  assert.deepEqual(f.mutations, ["create_pending", "arm", "arm", "arm"]);
});

test("GitHub recovers an acknowledged arm after transport loss without issuing the native mutation twice", async (t) => {
  const f = githubFixture(t);
  f.flags.loseArmResponse = true;
  await assert.rejects(
    f.api.scheduleMerge(request),
    (error) => error instanceof ForgeOperationError && error.uncertain,
  );
  assert.deepEqual(f.mutations, ["create_pending", "arm"]);
  const restarted = forge("github");
  const saved = { ...request, writeStage: "submitting" as const };
  assert.equal((await restarted.inspectMerge(saved)).resume, true);
  assert.equal(await restarted.scheduleMerge(saved, true), "scheduled");
  assert.deepEqual(f.mutations, ["create_pending", "arm", "success"]);
});

test("GitHub resumes its pending check after a lost creation acknowledgement but never repeats an uncertain release", async (t) => {
  const f = githubFixture(t);
  const stages: ForgeMergeWriteStage[] = [];
  /** Model the dispatcher's committed mutation boundaries. */
  async function checkpoint(stage: ForgeMergeWriteStage) {
    stages.push(stage);
  }
  f.flags.loseCreateResponse = true;
  await assert.rejects(f.api.scheduleMerge(request, false, checkpoint));
  assert.deepEqual(stages, ["creating_check"]);
  const pending = { ...request, writeStage: stages.at(-1) };
  assert.equal((await f.api.inspectMerge(pending)).resume, true);
  f.flags.delayRelease = true;
  await assert.rejects(f.api.scheduleMerge(pending, true, checkpoint));
  assert.deepEqual(stages, [
    "creating_check",
    "submitting",
    "armed",
    "releasing",
  ]);
  const releasing = { ...request, writeStage: stages.at(-1) };
  assert.equal((await f.api.inspectMerge(releasing)).resume, false);
  await assert.rejects(f.api.scheduleMerge(releasing, true, checkpoint));
  await assert.rejects(f.api.scheduleMerge(releasing, false, checkpoint));
  assert.deepEqual(f.mutations, ["create_pending", "arm", "success"]);
  // The one delayed release finally reaches the provider.
  Object.assign(f.runs[1], { status: "completed", conclusion: "success" });
  assert.equal((await f.api.inspectMerge(releasing)).state, "scheduled");
  assert.equal(await f.api.cancelMerge(releasing), "unsupported");
  f.pr.autoMergeRequest = null;
  assert.equal(await f.api.cancelMerge(releasing), "cancelled");
  assert.deepEqual(f.mutations, [
    "create_pending",
    "arm",
    "success",
    "cancelled",
  ]);
});

test("a depleted budget before native dispatch leaves the created check eligible to resume", async (t) => {
  const f = githubFixture(t);
  const now = Date.now();
  let current = now;
  t.mock.method(Date, "now", () => current);
  const stages: ForgeMergeWriteStage[] = [];
  await assert.rejects(
    f.api.scheduleMerge(request, false, async (stage) => {
      stages.push(stage);
      if (stage === "submitting") current += 120000;
    }),
    ForgeOperationError,
  );
  assert.deepEqual(stages, ["creating_check", "submitting", "creating_check"]);
  assert.deepEqual(f.mutations, ["create_pending"]);
  const recovered = forge("github");
  assert.equal(
    await recovered.scheduleMerge(
      { ...request, writeStage: stages.at(-1) },
      true,
    ),
    "scheduled",
  );
  assert.deepEqual(f.mutations, ["create_pending", "arm", "success"]);
});

test("GitHub detects a changed revision during scheduling and leaves the check pending", async (t) => {
  const f = githubFixture(t);
  f.flags.moveHeadOnArm = true;
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  assert.deepEqual(f.mutations, ["create_pending", "arm"]);
  assert.equal((await f.api.inspectMerge(request)).state, "stale");
});

test("GitHub leaves another actor's existing schedule untouched", async (t) => {
  const f = githubFixture(t);
  f.pr.autoMergeRequest = {
    enabledBy: { databaseId: 9 },
    mergeMethod: "SQUASH",
  };
  assert.equal((await f.api.inspectMerge(request)).reason, "existing_schedule");
  await assert.rejects(f.api.scheduleMerge(request));
  assert.deepEqual(f.mutations, []);
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

test("GitHub accepts a human-exempt ruleset only when this installation cannot bypass its own eligibility check", async (t) => {
  const f = githubFixture(t);
  f.pr.baseRef.branchProtectionRule.requiredStatusChecks.shift();
  f.flags.dedicatedGate = true;
  f.flags.rulesetBypass = "pull_requests_only";
  assert.equal((await f.api.inspectMerge(request)).state, "blocked");
  f.flags.rulesetBypass = "never";
  assert.equal((await f.api.inspectMerge(request)).state, "ready");
});

test("a restarted worker refuses to re-arm a schedule that disappeared after recovery inspection", async (t) => {
  const f = githubFixture(t);
  f.flags.loseArmResponse = true;
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  const restarted = forge("github");
  const saved = { ...request, writeStage: "submitting" as const };
  assert.equal((await restarted.inspectMerge(saved)).resume, true);
  f.pr.autoMergeRequest = null;
  await assert.rejects(
    restarted.scheduleMerge(saved, true),
    ForgeOperationError,
  );
  assert.deepEqual(f.mutations, ["create_pending", "arm"]);
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

test("GitHub refuses to release commit-wide eligibility for two open PRs sharing the same head", async (t) => {
  const f = githubFixture(t);
  f.repo.pullRequests.nodes.push({ number: 8, headRefOid: headSha });
  assert.equal((await f.api.inspectMerge(request)).reason, "shared_head_check");
  await assert.rejects(f.api.scheduleMerge(request), ForgeOperationError);
  assert.deepEqual(f.mutations, []);
});
