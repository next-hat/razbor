import { z } from "zod";

import {
  checks,
  eligibilityCheck,
  locked,
  lockFields,
  lockRule,
  retiredEligibilityCheck,
  requiredCheckState,
  rulesetChecks,
  type GithubApi,
} from "@forge-adapters/src/github/merge.js";
import {
  ForgeOperationError,
  type ForgeActor,
  type ForgeApprovalResult,
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

const query = `query RazborApproval($owner:String!, $name:String!, $number:Int!, $bot:String!) {
  repository(owner:$owner,name:$name) {
    databaseId defaultBranchRef{name}
    pullRequest(number:$number) {
      id number state isDraft author{login} headRefOid baseRefOid baseRefName
      isInMergeQueue autoMergeRequest{enabledAt} mergeable mergeStateStatus reviewDecision
      headRepository{databaseId} headRef{branchProtectionRule{${lockFields}}}
      commits(last:1){nodes{commit{oid status{contexts{context state}}}}}
      baseRef{branchProtectionRule{isAdminEnforced requiresApprovingReviews dismissesStaleReviews requiredStatusChecks{context app{databaseId}}}}
      reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}
      latestOpinionatedReviews(first:100){pageInfo{hasNextPage} nodes{state}}
      reviews(last:100,author:$bot){pageInfo{hasPreviousPage} nodes{body state commit{oid} author{... on Bot{databaseId}}}}
    }
  }
}`;

const vote = z.object({
  state: z.string(),
  body: z.string(),
  commit: z.object({ oid: commitSha }).nullable(),
  author: z.object({ databaseId: mergeId.optional() }).nullable(),
});

const approvalRepository = z.object({
  databaseId: mergeId,
  defaultBranchRef: z.object({ name: z.string() }),
  pullRequest: z.object({
    id: z.string().min(1),
    number: mergeId,
    state: z.string(),
    isDraft: z.boolean(),
    author: z.object({ login: z.string() }).nullable(),
    headRefOid: commitSha,
    baseRefOid: commitSha,
    baseRefName: z.string(),
    isInMergeQueue: z.boolean(),
    headRepository: z.object({ databaseId: mergeId }).nullable(),
    headRef: z.object({ branchProtectionRule: lockRule.nullable() }).nullable(),
    autoMergeRequest: z.object({}).nullable(),
    mergeable: z.string(),
    mergeStateStatus: z.string(),
    reviewDecision: z
      .enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"])
      .nullable(),
    commits: z.object({
      nodes: z
        .array(
          z.object({
            commit: z.object({
              oid: commitSha,
              status: z
                .object({
                  contexts: z
                    .array(z.object({ context: z.string(), state: z.string() }))
                    .max(2000),
                })
                .nullable(),
            }),
          }),
        )
        .length(1),
    }),
    baseRef: z.object({
      branchProtectionRule: z
        .object({
          isAdminEnforced: z.boolean(),
          requiresApprovingReviews: z.boolean(),
          dismissesStaleReviews: z.boolean(),
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
    }),
    reviewThreads: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean() }),
      nodes: z.array(z.object({ isResolved: z.boolean() })),
    }),
    latestOpinionatedReviews: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean() }),
      nodes: z.array(z.object({ state: z.string() })),
    }),
    reviews: z.object({
      pageInfo: z.object({ hasPreviousPage: z.boolean() }),
      nodes: z.array(vote),
    }),
  }),
});

/** Verify the destination, exact checked commit, current reviewer decisions, conversations and absence of an armed merge. */
export async function inspectGithubApproval(
  api: GithubApi,
  request: ForgeMergeRequest,
  bot: ForgeActor,
  readVoteOnly = false,
): Promise<{
  decision: ForgeMergeState;
  pullId?: string;
  previous?: ForgeApprovalResult;
}> {
  mergeRequestSchema.parse(request);
  if (
    !api.app ||
    api.app.id !== bot.id ||
    api.app.login.toLowerCase() !== bot.login.toLowerCase()
  )
    return { decision: mergeState("blocked", "approval_actor_unavailable") };
  const { repository: repo } = z
    .object({ repository: approvalRepository })
    .parse(
      await api.graphql(query, {
        owner: api.owner,
        name: api.name,
        number: request.number,
        bot: bot.login,
      }),
    );
  const pr = repo.pullRequest;
  const tip = pr.commits.nodes[0].commit;
  if (
    repo.databaseId !== request.externalRepositoryId ||
    repo.defaultBranchRef.name !== request.baseBranch ||
    pr.number !== String(request.number) ||
    tip.oid !== request.headSha ||
    differentRevision(request, pr.headRefOid, pr.baseRefOid, pr.baseRefName)
  )
    return { decision: mergeState("stale", "revision_changed") };
  if (pr.state !== "OPEN" || pr.isDraft)
    return { decision: mergeState("blocked", "not_open_ready") };
  if (!pr.author || pr.author.login.toLowerCase() === bot.login.toLowerCase())
    return { decision: mergeState("blocked", "approval_actor_unavailable") };
  if (pr.reviews.pageInfo.hasPreviousPage)
    return { decision: mergeState("blocked", "approval_unconfirmed") };

  const own = pr.reviews.nodes.filter(
    (v) => v.commit?.oid === request.headSha && v.author?.databaseId === bot.id,
  );
  const marker = approvalMarker(request);
  const opinion = own
    .reverse()
    .find((v) =>
      ["DISMISSED", "CHANGES_REQUESTED", "APPROVED"].includes(v.state),
    );
  let previous: ForgeApprovalResult | undefined;
  if (opinion)
    previous =
      opinion.state !== "APPROVED"
        ? "dismissed"
        : opinion.body.endsWith(marker)
          ? "approved"
          : "unsupported";
  if (readVoteOnly)
    return {
      decision: mergeState("ready", "approval_ready"),
      pullId: pr.id,
      previous,
    };
  if (pr.isInMergeQueue || pr.autoMergeRequest)
    return { decision: mergeState("blocked", "existing_schedule") };
  if (
    previous === "dismissed" ||
    previous === "unsupported" ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.latestOpinionatedReviews.pageInfo.hasNextPage ||
    pr.latestOpinionatedReviews.nodes.some(
      (r) => r.state === "CHANGES_REQUESTED",
    ) ||
    pr.reviewThreads.pageInfo.hasNextPage ||
    pr.reviewThreads.nodes.some((r) => !r.isResolved)
  )
    return { decision: mergeState("blocked", "merge_restrictions"), previous };

  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
    return {
      decision: mergeState("awaiting_checks", "required_check_pending"),
    };
  if (
    pr.mergeable !== "MERGEABLE" ||
    !["CLEAN", "BLOCKED", "UNSTABLE"].includes(pr.mergeStateStatus)
  )
    return { decision: mergeState("blocked", "merge_restrictions") };
  const rules = await rulesetChecks(api, request, true);
  const classic = pr.baseRef.branchProtectionRule;
  const sourceLocked =
    pr.headRepository?.databaseId === repo.databaseId &&
    locked(pr.headRef?.branchProtectionRule);
  if (
    !sourceLocked &&
    !(
      classic?.isAdminEnforced &&
      classic.requiresApprovingReviews &&
      classic.dismissesStaleReviews
    ) &&
    !rules.dismissesStaleReviews
  )
    return { decision: mergeState("blocked", "approval_unsupported") };
  const required = [
    ...(classic?.requiredStatusChecks ?? []),
    ...rules.required,
  ];
  const gateRequired = required.some(
    (rule) =>
      rule.context === eligibilityCheck &&
      rule.app?.databaseId === api.app?.appId,
  );
  // An approval never releases Razbor's own native-merge gate. Ignore only gate runs from this App.
  const runs = (await checks(api, request)).filter(
    (run) =>
      run.app.id !== api.app?.appId ||
      ![eligibilityCheck, retiredEligibilityCheck].includes(run.name),
  );
  const statuses = tip.status?.contexts ?? [];
  if (
    runs.some(
      (run) =>
        run.status === "completed" &&
        !["success", "skipped", "neutral"].includes(run.conclusion ?? ""),
    ) ||
    statuses.some((status) => ["FAILURE", "ERROR"].includes(status.state))
  )
    return { decision: mergeState("blocked", "required_check_failed") };
  if (
    (request.requirePassingChecks &&
      !runs.some((run) => run.conclusion === "success") &&
      !statuses.some((status) => status.state === "SUCCESS")) ||
    runs.some((run) => run.status !== "completed") ||
    statuses.some((status) => status.state !== "SUCCESS")
  )
    return {
      decision: mergeState("awaiting_checks", "required_check_pending"),
    };
  const unmet = requiredCheckState(
    required.filter(
      (rule) =>
        rule.app ||
        !statuses.some(
          (status) =>
            status.context === rule.context && status.state === "SUCCESS",
        ),
    ),
    runs,
    false,
    api.app.appId,
  );
  if (unmet) return { decision: unmet };
  if (
    pr.mergeStateStatus === "BLOCKED" &&
    pr.reviewDecision !== "REVIEW_REQUIRED" &&
    !gateRequired
  )
    return { decision: mergeState("blocked", "merge_restrictions") };
  return {
    decision: mergeState("ready", "approval_ready"),
    pullId: pr.id,
    previous,
  };
}

/** Bind owned approvals to a single repository, PR, destination branch, base and head across replacement reviews. */
function approvalMarker(request: ForgeMergeRequest) {
  return `<!-- razbor:approve:${request.externalRepositoryId}:${request.number}:${encodeURIComponent(request.baseBranch)}:${request.baseSha}:${request.headSha} -->`;
}

/** Submit one App approval by immutable PR node ID and commit OID, or reconcile its previously fenced review. */
export async function approveGithubReview(
  api: GithubApi,
  request: ForgeMergeRequest,
  bot: ForgeActor,
  reconcileOnly: boolean,
  beforeWrite: () => Promise<void>,
  acknowledged = false,
): Promise<ForgeApprovalResult> {
  const { decision, pullId, previous } = await inspectGithubApproval(
    api,
    request,
    bot,
    reconcileOnly,
  );
  if (previous) return previous;
  if (decision.state === "stale") return "stale";
  if (decision.state !== "ready" || !pullId) return "unsupported";
  if (reconcileOnly) return acknowledged ? "dismissed" : "absent";
  const marker = approvalMarker(request);
  await beforeWrite();
  const payload = await api.graphql(
    `mutation RazborApprove($pull:ID!, $head:GitObjectID!, $body:String!) {
      addPullRequestReview(input:{pullRequestId:$pull,commitOID:$head,event:APPROVE,body:$body}){
        pullRequestReview{state body commit{oid} author{... on Bot{databaseId}} pullRequest{id}}
      }
    }`,
    {
      pull: pullId,
      head: request.headSha,
      body: `Razbor approved reviewed commit ${request.headSha}.\n\n${marker}`,
    },
    true,
  );
  const result = z
    .object({
      addPullRequestReview: z.object({
        pullRequestReview: vote.extend({
          pullRequest: z.object({ id: z.string() }),
        }),
      }),
    })
    .safeParse(payload);
  const review = result.success
    ? result.data.addPullRequestReview.pullRequestReview
    : undefined;
  if (
    !review ||
    review.pullRequest.id !== pullId ||
    review.author?.databaseId !== bot.id ||
    review.commit?.oid !== request.headSha ||
    review.state !== "APPROVED" ||
    !review.body.endsWith(marker)
  )
    throw new ForgeOperationError("invalid-response", true);
  return "approved";
}
