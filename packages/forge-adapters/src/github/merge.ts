import { z } from "zod";

import { providerId } from "@forge-adapters/src/http.js";
import {
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeState,
} from "@forge-adapters/src/interactions.js";
import {
  commitSha,
  differentRevision,
  mergeId,
  mergeRequestSchema,
  mergeState,
} from "@forge-adapters/src/merge.js";
import type { HttpForgeTransport } from "@forge-adapters/src/transport.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

export const eligibilityCheck = "Razbor / merge eligibility";

export const retiredEligibilityCheck = "Razbor / retired merge eligibility";

export const lockFields = `pattern lockBranch lockAllowsFetchAndMerge allowsDeletions allowsForcePushes isAdminEnforced`;

const query = `query RazborMerge($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner,name:$name) {
    databaseId defaultBranchRef{name}
    pullRequest(number:$number) {number state headRefOid baseRefOid baseRefName autoMergeRequest{enabledBy{... on Bot{databaseId}} mergeMethod}}
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

const repository = z.object({
  databaseId: mergeId,
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  pullRequest: z.object({
    number: mergeId,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    headRefOid: commitSha,
    baseRefOid: commitSha,
    baseRefName: z.string(),
    autoMergeRequest: z
      .object({
        enabledBy: z.object({ databaseId: mergeId.optional() }).nullable(),
        mergeMethod: z.string(),
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

/** Recognize an enforced, immutable source branch when evaluating an approval. */
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
  commitOid: string,
  eligibilityName?: string,
) {
  const filter = eligibilityName
    ? `filter=all&check_name=${encodeURIComponent(eligibilityName)}&app_id=${api.app?.appId}`
    : "filter=latest";
  const commitRoute = `${api.route}/commits/${commitOid}`;
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
        row.head_sha !== commitOid ||
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
    suites.check_suites.some((suite) => suite.head_sha !== commitOid) ||
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

// These ref, history and file rules do not create CI requirements. Other active
// rules, such as required workflows, can require results without listing job names.
const rulesWithoutChecks = new Set([
  // Merge-group checks apply after queue admission. Approval independently
  // rejects a PR that is already queued or has auto-merge enabled.
  "merge_queue",
  "creation",
  "update",
  "deletion",
  "non_fast_forward",
  "required_linear_history",
  "required_signatures",
  "branch_name_pattern",
  "tag_name_pattern",
  "commit_message_pattern",
  "commit_author_email_pattern",
  "committer_email_pattern",
  "file_path_restriction",
  "max_file_path_length",
  "file_extension_restriction",
  "max_file_size",
]);

/** Collect named CI requirements, identify rules with unknown check names and verify stale-review dismissal for this App. */
export async function rulesetChecks(
  api: GithubApi,
  request: ForgeMergeRequest,
) {
  const all = await api.transport.list(
    `${api.route}/rules/branches/${encodeURIComponent(request.baseBranch)}`,
  );
  const required: { context: string; app: { databaseId: string } | null }[] =
    [];
  let dismissesStaleReviews = false;
  let hasUnmappedChecks = false;
  for (const value of all) {
    const type = z.object({ type: z.string() }).parse(value).type;
    if (type === "pull_request") {
      const rule = z
        .object({
          ruleset_id: mergeId,
          parameters: z.object({
            dismiss_stale_reviews_on_push: z.boolean().optional(),
          }),
        })
        .parse(value);
      if (
        rule.parameters.dismiss_stale_reviews_on_push &&
        (await enforcedRuleset(api, rule.ruleset_id))
      )
        dismissesStaleReviews = true;
      continue;
    }
    if (type !== "required_status_checks") {
      if (!rulesWithoutChecks.has(type)) hasUnmappedChecks = true;
      continue;
    }
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
    }
  }
  return { required, dismissesStaleReviews, hasUnmappedChecks };
}

/** Read terminal outcomes and identify old schedules and checks for retirement. No read authorizes a release. */
export async function inspectGithubMerge(
  api: GithubApi,
  request: ForgeMergeRequest,
): Promise<ForgeMergeState> {
  mergeRequestSchema.parse(request);
  if (!api.app?.appId)
    return mergeState("blocked", "installed_github_app_required");
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
    return mergeState("stale", "revision_changed");
  if (
    pr.headRefOid !== request.headSha ||
    pr.baseRefName !== request.baseBranch
  )
    return {
      ...mergeState("stale", "revision_changed"),
      terminal: pr.state === "MERGED",
    };
  if (pr.state === "MERGED") return mergeState("merged", "provider_merged");
  if (
    differentRevision(request, pr.headRefOid, pr.baseRefOid, pr.baseRefName) ||
    repo.defaultBranchRef?.name !== request.baseBranch
  )
    return mergeState("stale", "revision_changed");
  const blocked = mergeState("blocked", "github_schedule_owner_unbound");
  const scheduled = pr.autoMergeRequest;
  if (
    scheduled &&
    (scheduled.enabledBy?.databaseId !== api.app.id ||
      scheduled.mergeMethod !== request.method.toUpperCase())
  )
    return blocked;
  // A historical check can outlive its review even if the current review has no write stage.
  const gates = await checks(api, request.headSha, eligibilityCheck);
  if (gates.length !== 1) return blocked;
  const [gate] = gates;
  if (gate.external_id !== externalId(request)) {
    if (
      !scheduled &&
      gate.status === "in_progress" &&
      gate.conclusion === null &&
      gate.external_id
    ) {
      const id = mergeRequestSchema.shape.reviewId.safeParse(
        gate.external_id.split("/").at(-1),
      );
      if (
        id.success &&
        gate.external_id === externalId({ ...request, reviewId: id.data })
      )
        blocked.pendingCheckReviewId = id.data;
    }
    return blocked;
  }
  if (pr.state === "OPEN" && scheduled) {
    // A successful exact legacy check proves that an uncertain release reached GitHub.
    if (gate.status === "completed" && gate.conclusion === "success")
      return {
        ...mergeState("scheduled", "github_schedule_owner_unbound"),
        nativeArmed: true,
      };
    if (gate.status === "in_progress" && gate.conclusion === null)
      blocked.nativeArmed = true;
  }
  return blocked;
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
    names.map((name) => checks(api, request.headSha, name)),
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
    const verified = (await checks(api, request.headSha, name)).find(
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
