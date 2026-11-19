import { isDeepStrictEqual } from "node:util";

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
  type ForgeApprovalRetirement,
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

const maxVotePages = 20;

const opinionFields = `id state body commit{oid} author{... on Bot{databaseId}}`;

const voteFields = `{pageInfo{hasPreviousPage startCursor endCursor} nodes{${opinionFields}}}`;

const approvalVariables = `$owner:String!, $name:String!, $number:Int!, $bot:String!`;

const approvalSelection = `repository(owner:$owner,name:$name) {
    databaseId defaultBranchRef{name}
    pullRequest(number:$number) {
      id number state isDraft author{login} headRefOid baseRefOid baseRefName
      isInMergeQueue autoMergeRequest{enabledAt} mergeable mergeStateStatus reviewDecision
      headRepository{databaseId} headRef{branchProtectionRule{${lockFields}}}
      commits(last:1){nodes{commit{oid status{contexts{context state}}}}}
      baseRef{refUpdateRule{viewerAllowedToDismissReviews} branchProtectionRule{isAdminEnforced requiresApprovingReviews dismissesStaleReviews requiredStatusChecks{context app{databaseId}}}}
      reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}
      latestOpinionatedReviews(first:100){pageInfo{hasNextPage} nodes{state}}
      reviews(last:100,author:$bot)${voteFields}
    }
}`;

const query = `query RazborApproval(${approvalVariables}) { ${approvalSelection} }`;

const approvalWithVoteQuery = `query RazborApprovalWithVote(${approvalVariables},$voteId:ID!) {
  ${approvalSelection}
  currentVote:node(id:$voteId){... on PullRequestReview{${opinionFields} pullRequest{id}}}
}`;

const earlierVotesQuery = `query RazborEarlierVotes(${approvalVariables}, $before:String!) {
  repository(owner:$owner,name:$name) {
    databaseId defaultBranchRef{name}
    pullRequest(number:$number) {
      id number state isDraft headRefOid baseRefOid baseRefName
      reviews(last:100,author:$bot,before:$before)${voteFields}
    }
  }
}`;

const vote = z.object({
  state: z.string(),
  body: z.string(),
  commit: z.object({ oid: commitSha }).nullable(),
  author: z.object({ databaseId: mergeId.optional() }).nullable(),
});

const markedVote = vote.extend({ id: z.string().min(1) });

const voteOnPull = markedVote.extend({
  pullRequest: z.object({ id: z.string() }),
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
      refUpdateRule: z
        .object({ viewerAllowedToDismissReviews: z.boolean() })
        .nullable(),
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
      pageInfo: z.object({
        hasPreviousPage: z.boolean(),
        startCursor: z.string().nullish(),
        endCursor: z.string().nullish(),
      }),
      nodes: z.array(markedVote).max(100),
    }),
  }),
});

const approvalSnapshot = z.object({
  repository: approvalRepository,
  currentVote: z.unknown().optional(),
});

const votePage = approvalRepository.extend({
  pullRequest: approvalRepository.shape.pullRequest.pick({
    id: true,
    number: true,
    state: true,
    isDraft: true,
    headRefOid: true,
    baseRefOid: true,
    baseRefName: true,
    reviews: true,
  }),
});

/** Reject a page for a different PR, revision or destination, including a PR that closed or became a draft. */
function votePageRestriction(
  repo: z.infer<typeof votePage>,
  request: ForgeMergeRequest,
  pullId: string,
) {
  const pr = repo.pullRequest;
  if (
    repo.databaseId !== request.externalRepositoryId ||
    repo.defaultBranchRef.name !== request.baseBranch ||
    pr.number !== String(request.number) ||
    pr.id !== pullId ||
    differentRevision(request, pr.headRefOid, pr.baseRefOid, pr.baseRefName)
  )
    return mergeState("stale", "revision_changed");
  if (pr.state !== "OPEN" || pr.isDraft)
    return mergeState("blocked", "not_open_ready");
}

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
  const variables = {
    owner: api.owner,
    name: api.name,
    number: request.number,
    bot: bot.login,
  };
  /** Match submitted opinions by the authenticated App actor on this reviewed head. */
  function isPinnedOpinion(review: z.infer<typeof vote>) {
    return (
      review.author?.databaseId === bot.id &&
      review.commit?.oid === request.headSha &&
      ["DISMISSED", "CHANGES_REQUESTED", "APPROVED"].includes(review.state)
    );
  }
  /** Refresh protection and the newest reviews, including the current state of a previously matched older vote. */
  async function readCurrent(voteId?: string) {
    return approvalSnapshot.parse(
      voteId
        ? await api.graphql(approvalWithVoteQuery, { ...variables, voteId })
        : await api.graphql(query, variables),
    );
  }
  let { repository: repo } = await readCurrent();
  const pullId = repo.pullRequest.id;
  let page: z.infer<typeof votePage> = repo;
  const cursors = new Set<string>();
  let opinion: z.infer<typeof markedVote> | undefined;
  for (;;) {
    const restriction = votePageRestriction(page, request, pullId);
    if (restriction) return { decision: restriction };
    const reviews = page.pullRequest.reviews;
    opinion = [...reviews.nodes].reverse().find(isPinnedOpinion);
    if (opinion || !reviews.pageInfo.hasPreviousPage) break;
    const before = reviews.pageInfo.startCursor;
    if (!before || cursors.has(before) || cursors.size >= maxVotePages - 1)
      return { decision: mergeState("blocked", "approval_unconfirmed") };
    cursors.add(before);
    page = z
      .object({ repository: votePage })
      .parse(
        await api.graphql(earlierVotesQuery, { ...variables, before }),
      ).repository;
  }
  if (cursors.size) {
    const newest = repo.pullRequest.reviews;
    const refreshed = await readCurrent(opinion?.id);
    repo = refreshed.repository;
    const restriction = votePageRestriction(repo, request, pullId);
    if (restriction) return { decision: restriction };
    // Concurrent reviews can move the backward pagination window. Retry from a
    // fresh snapshot instead of combining an older opinion with a different tail.
    if (!isDeepStrictEqual(repo.pullRequest.reviews, newest))
      throw new ForgeOperationError("unavailable");
    if (opinion) {
      const current = voteOnPull.safeParse(refreshed.currentVote);
      if (
        !current.success ||
        current.data.id !== opinion.id ||
        current.data.pullRequest.id !== pullId ||
        !isPinnedOpinion(current.data)
      )
        throw new ForgeOperationError("unavailable");
      opinion = current.data;
    }
  }
  const pr = repo.pullRequest;
  const tip = pr.commits.nodes[0].commit;
  if (tip.oid !== request.headSha)
    return { decision: mergeState("stale", "revision_changed") };
  if (!pr.author || pr.author.login.toLowerCase() === bot.login.toLowerCase())
    return { decision: mergeState("blocked", "approval_actor_unavailable") };

  const marker = approvalMarker(request);
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
  if (!pr.baseRef.refUpdateRule?.viewerAllowedToDismissReviews)
    return { decision: mergeState("blocked", "approval_actor_unavailable") };
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
  const rules = await rulesetChecks(api, request);
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

const retirementPage = z.object({
  repository: z.object({
    databaseId: mergeId,
    pullRequest: z.object({
      id: z.string().min(1),
      number: mergeId,
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      reviews: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(markedVote),
      }),
    }),
  }),
});

/** Locate the earlier marked review even after a retarget or push, and dismiss only its immutable ID. */
export async function retireGithubApproval(
  api: GithubApi,
  request: ForgeMergeRequest,
  bot: ForgeActor,
  acknowledged: boolean,
  beforeWrite: () => Promise<void>,
): Promise<ForgeApprovalRetirement> {
  mergeRequestSchema.parse(request);
  if (
    !api.app ||
    api.app.id !== bot.id ||
    api.app.login.toLowerCase() !== bot.login.toLowerCase()
  )
    return "unconfirmed";
  const marker = approvalMarker(request);
  const votes: z.infer<typeof markedVote>[] = [];
  let after: string | null = null;
  let pullId: string | undefined;
  for (let page = 0; page < maxVotePages; page++) {
    const { repository } = retirementPage.parse(
      await api.graphql(
        `query RazborRetireApproval($owner:String!,$name:String!,$number:Int!,$bot:String!,$after:String) {
        repository(owner:$owner,name:$name) { databaseId pullRequest(number:$number) {
          id number state reviews(first:100,author:$bot,after:$after) {
            pageInfo{hasNextPage endCursor} nodes{id state body commit{oid} author{... on Bot{databaseId}}}
          }
        }}
      }`,
        {
          owner: api.owner,
          name: api.name,
          number: request.number,
          bot: bot.login,
          after,
        },
      ),
    );
    const pr = repository.pullRequest;
    if (
      repository.databaseId !== request.externalRepositoryId ||
      pr.number !== String(request.number) ||
      (pullId && pr.id !== pullId)
    )
      return "unconfirmed";
    if (pr.state === "MERGED") return "retired";
    pullId = pr.id;
    votes.push(
      ...pr.reviews.nodes.filter(
        (v) =>
          v.author?.databaseId === bot.id && v.commit?.oid === request.headSha,
      ),
    );
    if (!pr.reviews.pageInfo.hasNextPage) break;
    const next = pr.reviews.pageInfo.endCursor;
    if (!next || next === after || page === maxVotePages - 1)
      return "unconfirmed";
    after = next;
  }
  const owned = votes.filter((v) => v.body.endsWith(marker));
  if (!owned.length)
    return acknowledged && !votes.some((v) => v.state === "APPROVED")
      ? "retired"
      : "unconfirmed";
  if (owned.length !== 1) return "unconfirmed";
  const review = owned[0];
  if (review.state === "DISMISSED") return "retired";
  if (review.state !== "APPROVED") return "unconfirmed";
  await beforeWrite();
  const response = z
    .object({
      dismissPullRequestReview: z.object({
        pullRequestReview: voteOnPull,
      }),
    })
    .safeParse(
      await api.graphql(
        `mutation RazborDismissApproval($id:ID!, $message:String!) {
      dismissPullRequestReview(input:{pullRequestReviewId:$id,message:$message}) {
        pullRequestReview{id state body commit{oid} author{... on Bot{databaseId}} pullRequest{id}}
      }
    }`,
        {
          id: review.id,
          message:
            "Razbor withdrew its approval after the review or repository policy changed.",
        },
        true,
      ),
    );
  const dismissed = response.success
    ? response.data.dismissPullRequestReview.pullRequestReview
    : undefined;
  if (
    !dismissed ||
    dismissed.id !== review.id ||
    dismissed.pullRequest.id !== pullId ||
    dismissed.state !== "DISMISSED" ||
    dismissed.author?.databaseId !== bot.id ||
    dismissed.commit?.oid !== request.headSha ||
    !dismissed.body.endsWith(marker)
  )
    throw new ForgeOperationError("invalid-response", true);
  return "retired";
}
