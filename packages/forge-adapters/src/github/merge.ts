import { z } from "zod";

import { providerId } from "@forge-adapters/src/http.js";
import {
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeCheckpoint,
  type ForgeMergeState,
} from "@forge-adapters/src/interactions.js";
import {
  commitSha,
  differentRevision,
  mergeId,
  mergeRequestSchema,
  mergeState,
  requireMergeReady,
  sendMergeMutation,
} from "@forge-adapters/src/merge.js";
import type { HttpForgeTransport } from "@forge-adapters/src/transport.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

export const eligibilityCheck = "Razbor / merge eligibility";

export const retiredEligibilityCheck = "Razbor / retired merge eligibility";

export const lockFields = `pattern lockBranch lockAllowsFetchAndMerge allowsDeletions allowsForcePushes isAdminEnforced`;

const query = `query RazborMerge($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner,name:$name) {
    databaseId defaultBranchRef {name} autoMergeAllowed mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequests(first:100,states:OPEN){pageInfo{hasNextPage} nodes{number headRefOid}}
    branchProtectionRules(first:100){pageInfo{hasNextPage} nodes{${lockFields} restrictsPushes pushAllowances(first:100){pageInfo{hasNextPage} nodes{actor{__typename ... on App{databaseId}}}}}}
    pullRequest(number:$number) {
      id number state isDraft headRefOid baseRefOid baseRefName viewerCanMergeAsAdmin viewerCanEnableAutoMerge
      reviewDecision mergeable mergeStateStatus mergeQueue{id} headRepository{databaseId}
      headRef { branchProtectionRule{${lockFields}} target{... on Commit{oid parents(first:2){nodes{oid}}}} }
      baseRef {branchProtectionRule{pattern isAdminEnforced allowsForcePushes allowsDeletions requiresStatusChecks requiresConversationResolution requiresStrictStatusChecks requiredStatusChecks{context app{databaseId}}}}
      autoMergeRequest{ enabledBy{... on Bot{databaseId}} mergeMethod }
    }
  }
}`;

export const lockRule = z.object({
  pattern: z.string(),
  lockBranch: z.boolean(),
  lockAllowsFetchAndMerge: z.boolean(),
  allowsDeletions: z.boolean(),
  allowsForcePushes: z.boolean(),
  isAdminEnforced: z.boolean(),
});

const destinationRule = lockRule.extend({
  restrictsPushes: z.boolean(),
  pushAllowances: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(
      z.object({
        actor: z
          .object({
            __typename: z.enum(["User", "Team", "App"]),
            databaseId: mergeId.optional(),
          })
          .nullable(),
      }),
    ),
  }),
});

/** The single merge identity cannot publish changes to any other target, including a future branch. */
function excludesApp(rule: z.infer<typeof destinationRule>, appId: string) {
  return (
    locked(rule) ||
    (rule.isAdminEnforced &&
      rule.restrictsPushes &&
      !rule.pushAllowances.pageInfo.hasNextPage &&
      rule.pushAllowances.nodes.every(
        ({ actor }) =>
          actor &&
          (actor.__typename !== "App" ||
            (!!actor.databaseId && actor.databaseId !== appId)),
      ))
  );
}

const repository = z.object({
  databaseId: mergeId,
  defaultBranchRef: z.object({ name: z.string() }),
  autoMergeAllowed: z.boolean(),
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  pullRequests: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(z.object({ number: mergeId, headRefOid: commitSha })),
  }),
  branchProtectionRules: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(destinationRule),
  }),
  pullRequest: z.object({
    id: z.string().min(1),
    number: mergeId,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    headRefOid: commitSha,
    headRepository: z.object({ databaseId: mergeId }).nullable(),
    baseRefOid: commitSha,
    baseRefName: z.string(),
    viewerCanMergeAsAdmin: z.boolean(),
    viewerCanEnableAutoMerge: z.boolean(),
    reviewDecision: z.string().nullable(),
    mergeable: z.string(),
    mergeStateStatus: z.string(),
    mergeQueue: z.object({ id: z.string() }).nullable(),
    autoMergeRequest: z
      .object({
        enabledBy: z.object({ databaseId: mergeId.optional() }).nullable(),
        mergeMethod: z.string(),
      })
      .nullable(),
    headRef: z
      .object({
        branchProtectionRule: lockRule.nullable(),
        target: z.object({
          oid: commitSha,
          parents: z.object({ nodes: z.array(z.object({ oid: commitSha })) }),
        }),
      })
      .nullable(),
    baseRef: z
      .object({
        branchProtectionRule: z
          .object({
            pattern: z.string(),
            isAdminEnforced: z.boolean(),
            allowsDeletions: z.boolean(),
            allowsForcePushes: z.boolean(),
            requiresStatusChecks: z.boolean(),
            requiresConversationResolution: z.boolean().optional(),
            requiresStrictStatusChecks: z.boolean(),
            requiredStatusChecks: z
              .array(
                z.object({
                  context: z.string(),
                  app: z.object({ databaseId: mergeId }).nullable(),
                }),
              )
              .nullable(),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

const check = z.object({
  id: mergeId,
  name: z.string(),
  app: z.object({ id: mergeId }),
  head_sha: commitSha,
  external_id: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

const checkPageSize = 100;

const maxCheckPages = 20;

const checkCount = providerId
  .pipe(z.string().regex(/^\d+$/))
  .pipe(z.coerce.number<string>().int().nonnegative());

const checkPage = z.object({
  total_count: checkCount,
  check_runs: z.array(check).max(checkPageSize),
});

export type GithubApi = {
  route: string;
  owner: string;
  name: string;
  app: ForgeConnection["githubAppBot"];
  transport: HttpForgeTransport;
  graphql: (
    query: string,
    vars: Record<string, unknown>,
    mutating?: boolean,
  ) => Promise<unknown>;
};

type Inspection = {
  decision: ForgeMergeState;
  pullId?: string;
  checkId?: string;
};

/** Retargeting cannot move an armed request to a writable feature branch. */
export function locked(rule: z.infer<typeof lockRule> | null | undefined) {
  return (
    !!rule &&
    rule.lockBranch &&
    rule.isAdminEnforced &&
    !rule.lockAllowsFetchAndMerge &&
    !rule.allowsDeletions &&
    !rule.allowsForcePushes
  );
}

/** Bind the provider check to a single authoritative review even when several PRs share a commit. */
function externalId(request: ForgeMergeRequest) {
  return `razbor/${request.externalRepositoryId}/${request.number}/${request.baseSha}/${request.reviewId}`;
}

/** Read every reported run for this head, including historical runs when retiring a check. */
export async function checks(
  api: GithubApi,
  request: ForgeMergeRequest,
  eligibilityName?: string,
) {
  const filter = eligibilityName
    ? `filter=all&check_name=${encodeURIComponent(eligibilityName)}&app_id=${api.app?.appId}`
    : "filter=latest";
  const commitRoute = `${api.route}/commits/${request.headSha}`;
  const runs = new Map<string, z.infer<typeof check>>();
  let total: number | undefined;
  for (let page = 1; page <= maxCheckPages; page++) {
    const response = checkPage.parse(
      await api.transport.request(
        `${commitRoute}/check-runs?${filter}&per_page=${checkPageSize}&page=${page}`,
      ),
    );
    total ??= response.total_count;
    if (
      total > maxCheckPages * checkPageSize ||
      response.total_count !== total ||
      response.check_runs.length !== Math.min(checkPageSize, total - runs.size)
    )
      throw new ForgeOperationError("invalid-response");
    for (const row of response.check_runs) {
      if (
        row.head_sha !== request.headSha ||
        runs.has(row.id) ||
        (eligibilityName &&
          (row.name !== eligibilityName || row.app.id !== api.app?.appId))
      )
        throw new ForgeOperationError("invalid-response");
      runs.set(row.id, row);
    }
    if (runs.size === total) break;
  }
  // GitHub silently omits older suites from its commit-level check-runs endpoint
  // above 1,000 suites, even when its check-run total and pages agree.
  const suites = z
    .object({
      total_count: checkCount,
      check_suites: z.array(z.object({ head_sha: commitSha })).max(1),
    })
    .parse(
      await api.transport.request(`${commitRoute}/check-suites?per_page=1`),
    );
  if (
    suites.total_count > 1000 ||
    suites.check_suites.length !== Math.min(1, suites.total_count) ||
    suites.check_suites.some((suite) => suite.head_sha !== request.headSha) ||
    (suites.total_count === 0 && runs.size > 0)
  )
    throw new ForgeOperationError("invalid-response");
  return [...runs.values()];
}

/** Verify that this repository’s installation is subject to the specific active branch ruleset. */
async function enforcedRuleset(api: GithubApi, rulesetId: string) {
  const policy = z
    .object({
      id: mergeId,
      target: z.string(),
      enforcement: z.string(),
      current_user_can_bypass: z.string().optional(),
    })
    .parse(await api.transport.request(`${api.route}/rulesets/${rulesetId}`));
  return (
    policy.id === rulesetId &&
    policy.target === "branch" &&
    policy.enforcement === "active" &&
    policy.current_user_can_bypass === "never"
  );
}

/** Collect active ruleset checks, recording the actor-specific bypass decision for the eligibility rule. */
export async function rulesetChecks(
  api: GithubApi,
  request: ForgeMergeRequest,
  forApproval = false,
) {
  const all = await api.transport.list(
    `${api.route}/rules/branches/${encodeURIComponent(request.baseBranch)}`,
  );
  const required: { context: string; app: { databaseId: string } | null }[] =
    [];
  let pinned = false;
  let conversations = false;
  let dismissesStaleReviews = false;
  for (const value of all) {
    const type = z.object({ type: z.string() }).parse(value).type;
    if (type === "pull_request") {
      const rule = z
        .object({
          ruleset_id: mergeId,
          parameters: z.object({
            required_review_thread_resolution: z.boolean().optional(),
            dismiss_stale_reviews_on_push: z.boolean().optional(),
          }),
        })
        .parse(value);
      if (
        (rule.parameters.required_review_thread_resolution ||
          (forApproval && rule.parameters.dismiss_stale_reviews_on_push)) &&
        (await enforcedRuleset(api, rule.ruleset_id))
      ) {
        if (rule.parameters.required_review_thread_resolution)
          conversations = true;
        if (forApproval && rule.parameters.dismiss_stale_reviews_on_push)
          dismissesStaleReviews = true;
      }
    }
    if (type !== "required_status_checks") continue;
    const rule = z
      .object({
        ruleset_id: mergeId,
        parameters: z.object({
          required_status_checks: z.array(
            z.object({
              context: z.string(),
              integration_id: mergeId.nullish(),
            }),
          ),
        }),
      })
      .parse(value);
    for (const check of rule.parameters.required_status_checks) {
      required.push({
        context: check.context,
        app: check.integration_id ? { databaseId: check.integration_id } : null,
      });
      if (
        check.context !== eligibilityCheck ||
        check.integration_id !== api.app?.appId
      )
        continue;
      if (await enforcedRuleset(api, rule.ruleset_id)) pinned = true;
    }
  }
  return { required, pinned, conversations, dismissesStaleReviews };
}

/** Verify every configured CI check apart from Razbor's separate merge gate on this exact commit. */
export function requiredCheckState(
  requirements: { context: string; app: { databaseId: string } | null }[],
  runs: z.infer<typeof check>[],
  requireVerification: boolean,
  eligibilityAppId: string | undefined,
) {
  const required = requirements.filter(
    (s) =>
      s.context !== eligibilityCheck ||
      !eligibilityAppId ||
      s.app?.databaseId !== eligibilityAppId,
  );
  if (requireVerification && !required.length)
    return mergeState("blocked", "verification_check_required");
  for (const criterion of required) {
    const matching = runs.filter(
      (r) =>
        r.name === criterion.context &&
        (!criterion.app || criterion.app.databaseId === r.app.id),
    );
    if (!matching.length || matching.some((r) => r.status !== "completed"))
      return mergeState("awaiting_checks", "required_check_pending");
    if (matching.some((r) => r.conclusion !== "success"))
      return mergeState("blocked", "required_check_failed");
  }
}

/** Inspect native rules and status evidence without publishing or enabling anything. */
export async function inspectGithubMerge(
  api: GithubApi,
  request: ForgeMergeRequest,
): Promise<Inspection> {
  mergeRequestSchema.parse(request);
  if (!api.app?.appId)
    return { decision: mergeState("blocked", "installed_github_app_required") };
  const repo = z.object({ repository }).parse(
    await api.graphql(query, {
      owner: api.owner,
      name: api.name,
      number: request.number,
    }),
  ).repository;
  const pr = repo.pullRequest;
  if (
    repo.databaseId !== request.externalRepositoryId ||
    pr.number !== String(request.number)
  )
    return { decision: mergeState("stale", "revision_changed") };
  if (
    pr.headRefOid !== request.headSha ||
    pr.baseRefName !== request.baseBranch
  )
    return {
      decision: {
        ...mergeState("stale", "revision_changed"),
        terminal: pr.state === "MERGED",
      },
    };
  if (pr.state === "MERGED")
    return { decision: mergeState("merged", "provider_merged") };
  if (pr.state !== "OPEN" || pr.isDraft)
    return { decision: mergeState("blocked", "not_open_ready") };
  if (
    differentRevision(request, pr.headRefOid, pr.baseRefOid, pr.baseRefName) ||
    repo.defaultBranchRef.name !== request.baseBranch
  )
    return { decision: mergeState("stale", "revision_changed") };
  if (
    !repo.autoMergeAllowed ||
    !{
      merge: repo.mergeCommitAllowed,
      squash: repo.squashMergeAllowed,
      rebase: repo.rebaseMergeAllowed,
    }[request.method] ||
    pr.mergeQueue
  )
    return {
      decision: mergeState("blocked", "unsupported_github_merge_strategy"),
    };
  // A Check Run attaches to a commit, so its release can unblock every PR currently using that SHA.
  const sameHead = repo.pullRequests.nodes.filter(
    (open) => open.headRefOid === request.headSha,
  );
  if (
    repo.pullRequests.pageInfo.hasNextPage ||
    sameHead.length !== 1 ||
    sameHead[0].number !== String(request.number)
  )
    return { decision: mergeState("blocked", "shared_head_check") };
  const base = pr.baseRef?.branchProtectionRule;
  const targets = repo.branchProtectionRules;
  const appId = api.app.appId;
  if (
    targets.pageInfo.hasNextPage ||
    !targets.nodes.some((r) => r.pattern === "**/*" && excludesApp(r, appId)) ||
    !targets.nodes.every(
      (r) => r.pattern === request.baseBranch || excludesApp(r, appId),
    )
  )
    return {
      decision: mergeState("blocked", "exclusive_destination_required"),
    };
  if (
    pr.headRepository?.databaseId !== repo.databaseId ||
    !locked(pr.headRef?.branchProtectionRule) ||
    pr.headRef?.target.oid !== request.headSha
  )
    return { decision: mergeState("blocked", "immutable_source_required") };
  if (
    pr.headRef.target.parents.nodes.length !== 1 ||
    pr.headRef.target.parents.nodes[0]?.oid !== request.baseSha
  )
    return { decision: mergeState("blocked", "direct_child_required") };
  if (
    pr.viewerCanMergeAsAdmin ||
    !base?.isAdminEnforced ||
    base.pattern !== request.baseBranch ||
    base.allowsForcePushes ||
    base.allowsDeletions ||
    !base.requiresStrictStatusChecks ||
    !base.requiresStatusChecks ||
    !base.requiredStatusChecks
  )
    return {
      decision: mergeState("blocked", "app_pinned_strict_check_required"),
    };
  const enforced = await rulesetChecks(api, request);
  if (!base.requiresConversationResolution && !enforced.conversations)
    return {
      decision: mergeState("blocked", "conversation_resolution_required"),
    };
  const classicGate = base.requiredStatusChecks.some(
    (c) => c.context === eligibilityCheck && c.app?.databaseId === appId,
  );
  if (!classicGate && !enforced.pinned)
    return {
      decision: mergeState("blocked", "app_pinned_strict_check_required"),
    };
  if (
    pr.autoMergeRequest &&
    (pr.autoMergeRequest.enabledBy?.databaseId !== api.app.id ||
      pr.autoMergeRequest.mergeMethod !== request.method.toUpperCase())
  )
    return { decision: mergeState("blocked", "existing_schedule") };
  if (
    !["MERGEABLE", "UNKNOWN"].includes(pr.mergeable) ||
    !["CLEAN", "BLOCKED", "UNSTABLE", "HAS_HOOKS", "UNKNOWN"].includes(
      pr.mergeStateStatus,
    ) ||
    (pr.reviewDecision && pr.reviewDecision !== "APPROVED")
  )
    return { decision: mergeState("blocked", "merge_restrictions") };
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
    return {
      decision: mergeState("awaiting_checks", "required_check_pending"),
    };
  const runs = await checks(api, request);
  if (
    runs.some(
      (row) =>
        row.name === retiredEligibilityCheck &&
        row.app.id === api.app?.appId &&
        row.external_id === externalId(request),
    )
  )
    return { decision: mergeState("blocked", "retired_eligibility_check") };
  const gates = runs.filter(
    (row) => row.name === eligibilityCheck && row.app.id === api.app?.appId,
  );
  const gate = gates[0];
  if (gates.length > 1 || (gate && gate.external_id !== externalId(request))) {
    const decision = mergeState("blocked", "conflicting_eligibility_check");
    if (
      gates.length === 1 &&
      !pr.autoMergeRequest &&
      gate.status === "in_progress" &&
      gate.conclusion === null &&
      gate.external_id
    ) {
      const reviewId = mergeRequestSchema.shape.reviewId.safeParse(
        gate.external_id.split("/").at(-1),
      );
      if (
        reviewId.success &&
        gate.external_id === externalId({ ...request, reviewId: reviewId.data })
      )
        decision.pendingCheckReviewId = reviewId.data;
    }
    return { decision };
  }
  // Never release an App check from an old review or adopt another actor's armed request.
  if (pr.autoMergeRequest && !gate)
    return { decision: mergeState("blocked", "unowned_schedule") };
  if (request.writeStage === "creating_check" && !gate && !pr.autoMergeRequest)
    return { decision: mergeState("blocked", "eligibility_check_unconfirmed") };
  if (gate?.status === "completed") {
    if (gate.conclusion === "success" && pr.autoMergeRequest)
      return {
        decision: mergeState("scheduled", "provider_scheduled"),
        checkId: gate.id,
      };
    return { decision: mergeState("blocked", "retired_eligibility_check") };
  }
  const verification = requiredCheckState(
    [...base.requiredStatusChecks, ...enforced.required],
    runs,
    request.requirePassingChecks,
    api.app.appId,
  );
  if (verification) return { decision: verification };
  if (!pr.autoMergeRequest && !pr.viewerCanEnableAutoMerge)
    return { decision: mergeState("blocked", "native_auto_merge_unavailable") };
  return {
    decision: {
      state: "ready",
      reason: "provider_ready",
      nativeArmed: !!pr.autoMergeRequest,
      resume: pr.autoMergeRequest
        ? request.writeStage === "armed" || request.writeStage === "submitting"
        : request.writeStage === "creating_check" && !!gate,
    },
    pullId: pr.id,
    checkId: gate?.id,
  };
}

/** Arm a guarded PR behind a pending check, then release only its exact App-owned check ID. */
export async function scheduleGithubMerge(
  api: GithubApi,
  request: ForgeMergeRequest,
  resumeOnly: boolean,
  checkpoint?: ForgeMergeCheckpoint,
): Promise<"scheduled" | "merged"> {
  let inspected = await inspectGithubMerge(api, request);
  requireMergeReady(inspected.decision);
  if (
    resumeOnly !== !!inspected.decision.resume ||
    (!resumeOnly &&
      (inspected.decision.nativeArmed ||
        inspected.checkId ||
        (request.writeStage && request.writeStage !== "prepared")))
  )
    throw new ForgeOperationError("unsupported", resumeOnly);
  if (!inspected.checkId) {
    await sendMergeMutation(checkpoint, "prepared", "creating_check", () =>
      api.transport.request(`${api.route}/check-runs`, "POST", {
        name: eligibilityCheck,
        head_sha: request.headSha,
        external_id: externalId(request),
        status: "in_progress",
      }),
    );
    inspected = await inspectGithubMerge(api, request);
    requireMergeReady(inspected.decision);
    if (!inspected.checkId || inspected.decision.nativeArmed)
      throw new ForgeOperationError("unavailable", true);
  }
  if (!inspected.decision.nativeArmed) {
    const response = await sendMergeMutation(
      checkpoint,
      "creating_check",
      "submitting",
      () =>
        api.graphql(
          `mutation RazborEnable($input:EnablePullRequestAutoMergeInput!){enablePullRequestAutoMerge(input:$input){pullRequest{id}}}`,
          {
            input: {
              pullRequestId: inspected.pullId,
              expectedHeadOid: request.headSha,
              mergeMethod: request.method.toUpperCase(),
              clientMutationId: request.reviewId,
            },
          },
          true,
        ),
    );
    const ack = z
      .object({
        enablePullRequestAutoMerge: z.object({
          pullRequest: z.object({ id: z.string() }),
        }),
      })
      .safeParse(response);
    if (
      !ack.success ||
      ack.data.enablePullRequestAutoMerge.pullRequest.id !== inspected.pullId
    )
      throw new ForgeOperationError("unavailable", true);
    await checkpoint?.("armed");
    try {
      inspected = await inspectGithubMerge(api, request);
    } catch {
      throw new ForgeOperationError("unavailable", true);
    }
  }
  if (
    inspected.decision.state !== "ready" ||
    !inspected.decision.nativeArmed ||
    !inspected.checkId
  )
    throw new ForgeOperationError("unavailable", true);
  // A single release may be in flight. A pending check never justifies replaying it.
  const released = check.safeParse(
    await sendMergeMutation(checkpoint, "armed", "releasing", () =>
      api.transport.request(
        `${api.route}/check-runs/${inspected.checkId}`,
        "PATCH",
        { status: "completed", conclusion: "success" },
      ),
    ),
  );
  if (
    !released.success ||
    released.data.id !== inspected.checkId ||
    released.data.app.id !== api.app?.appId ||
    released.data.name !== eligibilityCheck ||
    released.data.external_id !== externalId(request) ||
    released.data.head_sha !== request.headSha ||
    released.data.status !== "completed" ||
    released.data.conclusion !== "success"
  )
    throw new ForgeOperationError("unavailable", true);
  await checkpoint?.("acknowledged");
  try {
    const { decision } = await inspectGithubMerge(api, request);
    if (decision.state === "scheduled" || decision.state === "merged")
      return decision.state;
  } catch {
    /* The eligibility write may already have released the native merge. */
  }
  throw new ForgeOperationError("unavailable", true);
}

/** Verify the native PR flag independently of checks, even after the PR head or base changes. */
async function nativeScheduleAbsent(
  api: GithubApi,
  request: ForgeMergeRequest,
) {
  const result = z
    .object({
      repository: z.object({
        databaseId: mergeId,
        pullRequest: z.object({
          number: mergeId,
          autoMergeRequest: z.object({}).nullable(),
        }),
      }),
    })
    .parse(
      await api.graphql(
        `query RazborNativeSchedule($owner:String!, $name:String!, $number:Int!) {
      repository(owner:$owner,name:$name){databaseId pullRequest(number:$number){number autoMergeRequest{enabledAt}}}
    }`,
        { owner: api.owner, name: api.name, number: request.number },
      ),
    ).repository;
  return (
    result.databaseId === request.externalRepositoryId &&
    result.pullRequest.number === String(request.number) &&
    !result.pullRequest.autoMergeRequest
  );
}

/** Retire only this review's exact App-owned check and verify that no native schedule remains. */
export async function cancelGithubMerge(
  api: GithubApi,
  request: ForgeMergeRequest,
): Promise<"cancelled" | "absent" | "unsupported"> {
  mergeRequestSchema.parse(request);
  if (!api.app?.appId) return "unsupported";
  const target = z
    .object({ id: mergeId })
    .parse(await api.transport.request(api.route));
  if (target.id !== request.externalRepositoryId) return "unsupported";
  const creating = request.writeStage === "creating_check";
  const names = creating
    ? [eligibilityCheck, retiredEligibilityCheck]
    : [eligibilityCheck];
  const matching = await Promise.all(
    names.map((name) => checks(api, request, name)),
  );
  const owned = matching
    .flat()
    .filter(
      (row) =>
        (row.name === eligibilityCheck ||
          (creating && row.name === retiredEligibilityCheck)) &&
        row.app.id === api.app?.appId &&
        row.external_id === externalId(request),
    );
  if (owned.length > 1) return "unsupported";
  const gate = owned[0];
  if (creating) {
    // A delayed create can still arrive after an empty read. A completed success
    // or an active native arm also contradicts this pre-submission checkpoint.
    if (
      !gate ||
      !(
        (gate.status === "in_progress" &&
          gate.conclusion === null &&
          gate.name === eligibilityCheck) ||
        (gate.status === "completed" && gate.conclusion === "cancelled")
      ) ||
      !(await nativeScheduleAbsent(api, request))
    )
      return "unsupported";
  }
  if (gate) {
    const name = creating ? retiredEligibilityCheck : eligibilityCheck;
    if (gate.conclusion !== "cancelled" || gate.name !== name)
      await api.transport.request(
        `${api.route}/check-runs/${gate.id}`,
        "PATCH",
        {
          ...(creating ? { name } : {}),
          status: "completed",
          conclusion: "cancelled",
        },
      );
    const verified = (await checks(api, request, name)).find(
      (row) => row.id === gate.id,
    );
    if (
      verified?.name !== name ||
      verified.app.id !== api.app.appId ||
      verified.external_id !== externalId(request) ||
      verified.status !== "completed" ||
      verified.conclusion !== "cancelled"
    )
      throw new ForgeOperationError("unavailable", true);
  }
  // The native disable mutation lacks an ownership precondition. Wait for
  // operator removal instead of disabling a concurrent human authorization.
  if (!(await nativeScheduleAbsent(api, request))) return "unsupported";
  return gate ? "cancelled" : "absent";
}
