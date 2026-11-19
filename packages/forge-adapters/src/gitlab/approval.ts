import { z } from "zod";

import { pendingGitlabMergeStatus } from "@forge-adapters/src/gitlab/merge.js";
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
import type { HttpForgeTransport } from "@forge-adapters/src/transport.js";

const approval = z.object({
  iid: mergeId,
  project_id: mergeId,
  approved_by: z.array(z.object({ user: z.object({ id: mergeId }) })),
  user_can_approve: z.boolean().optional(),
});

const botAccount = z.object({
  id: mergeId,
  bot: z.boolean(),
  is_admin: z.boolean().optional(),
});

const mergeRequest = z.object({
  iid: mergeId,
  project_id: mergeId,
  state: z.string(),
  draft: z.boolean(),
  sha: commitSha,
  target_branch: z.string(),
  author: z.object({ id: mergeId }),
  diff_refs: z.object({ head_sha: commitSha }).nullable(),
  head_pipeline: z.object({ sha: commitSha, status: z.string() }).nullable(),
  merge_when_pipeline_succeeds: z.boolean(),
  has_conflicts: z.boolean(),
  detailed_merge_status: z.string(),
  blocking_discussions_resolved: z.boolean(),
});

/** Inspect the exact MR as the bound bot. Native auto-merge, conflicts and requested changes prohibit a vote. */
export async function inspectGitlabApproval(
  transport: HttpForgeTransport,
  projectRoute: string,
  request: ForgeMergeRequest,
  bot: ForgeActor,
  readVoteOnly = false,
): Promise<{ decision: ForgeMergeState; active?: boolean }> {
  mergeRequestSchema.parse(request);
  const project = z
    .object({
      id: mergeId,
      default_branch: z.string(),
      merge_trains_enabled: z.boolean().optional(),
    })
    .parse(await transport.request(projectRoute));
  if (
    project.id !== request.externalRepositoryId ||
    project.default_branch !== request.baseBranch
  )
    return { decision: mergeState("stale", "destination_changed") };
  const projectById = `projects/${project.id}`;
  const route = `${projectById}/merge_requests/${request.number}`;
  const mr = mergeRequest.parse(await transport.request(route));
  const branch = z
    .object({ name: z.string(), commit: z.object({ id: commitSha }) })
    .parse(
      await transport.request(
        `${projectById}/repository/branches/${encodeURIComponent(request.baseBranch)}`,
      ),
    );
  if (
    mr.project_id !== project.id ||
    mr.iid !== String(request.number) ||
    branch.name !== mr.target_branch ||
    differentRevision(request, mr.sha, branch.commit.id, mr.target_branch)
  )
    return { decision: mergeState("stale", "revision_changed") };
  if (mr.state !== "opened" || mr.draft)
    return { decision: mergeState("blocked", "not_open_ready") };
  const actor = botAccount.parse(await transport.request("user"));
  if (
    !actor.bot ||
    actor.is_admin ||
    actor.id !== bot.id ||
    actor.id === mr.author.id
  )
    return { decision: mergeState("blocked", "approval_actor_unavailable") };
  const current = approval.parse(await transport.request(`${route}/approvals`));
  if (current.iid !== mr.iid || current.project_id !== project.id)
    return { decision: mergeState("stale", "revision_changed") };
  const active = current.approved_by.some(({ user }) => user.id === bot.id);
  if (readVoteOnly)
    return { decision: mergeState("ready", "approval_ready"), active };
  if (project.merge_trains_enabled === undefined)
    return { decision: mergeState("blocked", "approval_unsupported") };
  if (project.merge_trains_enabled || mr.merge_when_pipeline_succeeds)
    return { decision: mergeState("blocked", "existing_schedule") };
  const settings = z
    .object({
      reset_approvals_on_push: z.boolean(),
      selective_code_owner_removals: z.boolean(),
    })
    .parse(await transport.request(`${projectById}/approvals`));
  if (
    !settings.reset_approvals_on_push ||
    settings.selective_code_owner_removals
  )
    return { decision: mergeState("blocked", "approval_unsupported") };
  if (mr.has_conflicts || !mr.blocking_discussions_resolved)
    return { decision: mergeState("blocked", "merge_restrictions") };
  if (
    pendingGitlabMergeStatus(mr.detailed_merge_status) ||
    mr.diff_refs?.head_sha !== request.headSha
  )
    return { decision: mergeState("awaiting_checks", "pipeline_pending") };
  const pipeline = mr.head_pipeline;
  if (request.requirePassingChecks || pipeline) {
    if (
      !pipeline ||
      pipeline.sha !== mr.sha ||
      [
        "running",
        "pending",
        "created",
        "preparing",
        "waiting_for_resource",
        "scheduled",
      ].includes(pipeline.status)
    )
      return { decision: mergeState("awaiting_checks", "pipeline_pending") };
    if (pipeline.status !== "success")
      return { decision: mergeState("blocked", "pipeline_failed") };
  }
  if (!["mergeable", "not_approved"].includes(mr.detailed_merge_status))
    return { decision: mergeState("blocked", "merge_restrictions") };
  const reviewers = z
    .array(
      z.object({
        state: z.enum([
          "unreviewed",
          "unapproved",
          "review_started",
          "reviewed",
          "requested_changes",
          "approved",
        ]),
      }),
    )
    .parse(await transport.list(`${route}/reviewers`, "per_page", true));
  if (reviewers.some((reviewer) => reviewer.state === "requested_changes"))
    return { decision: mergeState("blocked", "merge_restrictions") };
  if (!active && current.user_can_approve !== true)
    return { decision: mergeState("blocked", "approval_actor_unavailable") };
  return { decision: mergeState("ready", "approval_ready"), active };
}

/** Submit with GitLab's SHA precondition. Ordinary approval listings do not identify the commit of a vote. */
export async function approveGitlabReview(
  transport: HttpForgeTransport,
  projectRoute: string,
  request: ForgeMergeRequest,
  bot: ForgeActor,
  reconcileOnly: boolean,
  beforeWrite: () => Promise<void>,
  acknowledged = false,
): Promise<ForgeApprovalResult> {
  const { decision, active } = await inspectGitlabApproval(
    transport,
    projectRoute,
    request,
    bot,
    reconcileOnly,
  );
  if (decision.state === "stale") return "stale";
  if (decision.state === "awaiting_checks") return "checks_pending";
  if (decision.state !== "ready") return "unsupported";
  if (active)
    return acknowledged ? "approved" : reconcileOnly ? "absent" : "unsupported";
  if (reconcileOnly) return acknowledged ? "dismissed" : "absent";
  await beforeWrite();
  const result = approval.safeParse(
    await transport.request(
      `projects/${request.externalRepositoryId}/merge_requests/${request.number}/approve`,
      "POST",
      { sha: request.headSha },
    ),
  );
  if (
    !result.success ||
    result.data.project_id !== request.externalRepositoryId ||
    result.data.iid !== String(request.number) ||
    !result.data.approved_by.some(({ user }) => user.id === bot.id)
  )
    throw new ForgeOperationError("invalid-response", true);
  return "approved";
}

/** Withdraw the bound account's acknowledged vote; GitLab scopes this write to the MR and offers no SHA precondition. */
export async function retireGitlabApproval(
  transport: HttpForgeTransport,
  projectRoute: string,
  request: ForgeMergeRequest,
  bot: ForgeActor,
  acknowledged: boolean,
  beforeWrite: () => Promise<void>,
  withdrawalUncertain: boolean,
): Promise<ForgeApprovalRetirement> {
  mergeRequestSchema.parse(request);
  const project = z
    .object({ id: mergeId })
    .parse(await transport.request(projectRoute));
  if (project.id !== request.externalRepositoryId) return "unconfirmed";
  const route = `projects/${project.id}/merge_requests/${request.number}`;
  const mr = mergeRequest
    .pick({ iid: true, project_id: true, state: true, sha: true })
    .parse(await transport.request(route));
  if (mr.project_id !== project.id || mr.iid !== String(request.number))
    return "unconfirmed";
  if (mr.state === "merged") return "retired";
  if (
    !["opened", "closed"].includes(mr.state) ||
    !acknowledged ||
    withdrawalUncertain
  )
    return "unconfirmed";
  const actor = botAccount.parse(await transport.request("user"));
  if (!actor.bot || actor.is_admin || actor.id !== bot.id) return "unconfirmed";
  const current = approval.parse(await transport.request(`${route}/approvals`));
  if (current.project_id !== project.id || current.iid !== mr.iid)
    return "unconfirmed";
  if (!current.approved_by.some(({ user }) => user.id === actor.id))
    return "retired";
  // A vote on a different head might belong to another operation. The caller
  // serializes our approvals for the entire MR while the withdrawal is pending.
  if (mr.sha !== request.headSha) return "unconfirmed";
  await beforeWrite();
  const response = approval.safeParse(
    await transport.request(`${route}/unapprove`, "POST"),
  );
  if (
    !response.success ||
    response.data.project_id !== project.id ||
    response.data.iid !== mr.iid ||
    response.data.approved_by.some(({ user }) => user.id === actor.id)
  )
    throw new ForgeOperationError("invalid-response", true);
  return "retired";
}
