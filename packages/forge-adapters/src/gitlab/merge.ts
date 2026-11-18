import { z } from "zod";

import {
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeCheckpoint,
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

const mrSchema = z.object({
  iid: mergeId,
  project_id: mergeId,
  state: z.string(),
  sha: commitSha,
  target_branch: z.string(),
  draft: z.boolean(),
  squash_on_merge: z.boolean().optional(),
  squash_commit_sha: commitSha.nullish(),
  merge_when_pipeline_succeeds: z.boolean(),
  merge_user: z.object({ id: mergeId }).nullable(),
  detailed_merge_status: z.string(),
  blocking_discussions_resolved: z.boolean(),
  has_conflicts: z.boolean(),
  head_pipeline: z.object({ sha: commitSha, status: z.string() }).nullable(),
});

const access = z.object({
  access_level: z.preprocess(
    (v) => String(v),
    z.enum(["0", "30", "40", "50", "60"]).transform(Number),
  ),
  member_role_id: mergeId.nullish(),
  user_id: mergeId.nullish(),
  group_id: mergeId.nullish(),
  deploy_key_id: mergeId.nullish(),
});

const rule = z.object({
  name: z.string(),
  allow_force_push: z.boolean(),
  merge_access_levels: z.array(access),
  push_access_levels: z.array(access),
});

/** Restrict automatic merge authority to the exact destination, even if someone retargets the MR mid-request. */
function onlyDestination(
  rules: z.infer<typeof rule>[],
  target: string,
  botId: string,
) {
  if (
    !rules.some((branch) => branch.name === "*") ||
    !rules.some((branch) => branch.name === target)
  )
    return false;
  return rules.every(
    (branch) =>
      !branch.allow_force_push &&
      (branch.name === target ||
        [...branch.merge_access_levels, ...branch.push_access_levels].every(
          (entry) =>
            !entry.member_role_id &&
            !entry.group_id &&
            !entry.deploy_key_id &&
            (entry.user_id
              ? entry.user_id !== botId
              : entry.access_level === 0 || entry.access_level >= 40),
        )),
  );
}

/** Check the native scheduler, project merge strategy, target protection and pipeline against the saved review. */
export async function inspectGitlabMerge(
  transport: HttpForgeTransport,
  projectRoute: string,
  request: ForgeMergeRequest,
) {
  mergeRequestSchema.parse(request);
  const route = `${projectRoute}/merge_requests/${request.number}`;
  const mr = mrSchema.parse(await transport.request(route));
  if (
    mr.project_id !== request.externalRepositoryId ||
    mr.iid !== String(request.number)
  )
    return mergeState("stale", "revision_changed");
  if (mr.sha !== request.headSha || mr.target_branch !== request.baseBranch)
    return {
      ...mergeState("stale", "revision_changed"),
      terminal: mr.state === "merged",
    };
  if (mr.state === "merged") {
    if (request.method === "merge" && mr.squash_commit_sha !== null)
      return {
        ...mergeState("blocked", "merge_method_unavailable"),
        terminal: true,
      };
    return mergeState("merged", "provider_merged");
  }
  if (mr.state !== "opened" || mr.draft)
    return mergeState("blocked", "not_open_ready");
  const actor = z
    .object({ id: mergeId, bot: z.boolean(), is_admin: z.boolean().optional() })
    .parse(await transport.request("user"));
  if (!actor.bot || actor.is_admin === true)
    return mergeState("blocked", "project_bot_required");
  const project = z
    .object({
      id: mergeId,
      default_branch: z.string(),
      merge_method: z.string(),
      squash_option: z.string(),
      only_allow_merge_if_pipeline_succeeds: z.boolean(),
      allow_merge_on_skipped_pipeline: z.boolean(),
      automatic_rebase_enabled: z.boolean().optional(),
      merge_trains_enabled: z.boolean().optional(),
      permissions: z.object({
        project_access: z
          .object({ access_level: z.coerce.number() })
          .nullable(),
        group_access: z.object({ access_level: z.coerce.number() }).nullable(),
      }),
    })
    .parse(await transport.request(projectRoute));
  if (
    project.id !== request.externalRepositoryId ||
    project.default_branch !== request.baseBranch
  )
    return mergeState("stale", "destination_changed");
  const version = z
    .object({ version: z.string() })
    .parse(await transport.request("version")).version;
  const knownVersion = /^(?:17\.11|1[89]\.\d+)\.\d+(?:-(?:ce|ee))?$/.test(
    version,
  );
  if (
    !knownVersion ||
    project.automatic_rebase_enabled === true ||
    (project.automatic_rebase_enabled === undefined &&
      !version.startsWith("17.11.")) ||
    !["ff", "rebase_merge"].includes(project.merge_method) ||
    project.merge_trains_enabled !== false
  )
    return mergeState("blocked", "unsupported_gitlab_merge_strategy");
  if (
    request.method === "rebase" ||
    (request.method === "merge" &&
      // GitLab can ignore squash:false. A per-MR preference can change after
      // preflight, so require a project-enforced unsquashed merge.
      (project.squash_option !== "never" ||
        project.merge_method !== "rebase_merge" ||
        mr.squash_on_merge !== false)) ||
    (request.method === "squash" &&
      !["always", "default_on", "default_off"].includes(project.squash_option))
  )
    return mergeState("blocked", "merge_method_unavailable");
  const level = Math.max(
    project.permissions.group_access?.access_level ?? 0,
    project.permissions.project_access?.access_level ?? 0,
  );
  if (
    level !== 30 ||
    !onlyDestination(
      z
        .array(rule)
        .parse(
          await transport.list(
            `${projectRoute}/protected_branches`,
            "per_page",
            true,
          ),
        ),
      request.baseBranch,
      actor.id,
    )
  )
    return mergeState("blocked", "exclusive_destination_required");
  const branch = z
    .object({
      name: z.string(),
      protected: z.boolean(),
      commit: z.object({ id: commitSha }),
    })
    .parse(
      await transport.request(
        `${projectRoute}/repository/branches/${encodeURIComponent(request.baseBranch)}`,
      ),
    );
  if (differentRevision(request, mr.sha, branch.commit.id, branch.name))
    return mergeState("stale", "revision_changed");
  if (
    !branch.protected ||
    !project.only_allow_merge_if_pipeline_succeeds ||
    project.allow_merge_on_skipped_pipeline
  )
    return mergeState("blocked", "protected_successful_pipeline_required");
  const head = z
    .object({ id: commitSha, parent_ids: z.array(commitSha) })
    .parse(
      await transport.request(`${projectRoute}/repository/commits/${mr.sha}`),
    );
  // A fast-forward-only target could otherwise advance to an intermediate reviewed commit.
  if (
    head.id !== mr.sha ||
    head.parent_ids.length !== 1 ||
    head.parent_ids[0] !== branch.commit.id
  )
    return mergeState("blocked", "direct_child_required");
  if (mr.merge_when_pipeline_succeeds)
    return mr.merge_user?.id === actor.id ||
      (mr.merge_user === null && request.writeStage === "acknowledged")
      ? mergeState("scheduled", "provider_scheduled")
      : mergeState("blocked", "existing_schedule");
  if (mr.has_conflicts || !mr.blocking_discussions_resolved)
    return mergeState("blocked", "merge_restrictions");
  if (
    !mr.head_pipeline ||
    mr.head_pipeline.sha !== mr.sha ||
    [
      "running",
      "pending",
      "created",
      "preparing",
      "waiting_for_resource",
    ].includes(mr.head_pipeline.status)
  )
    return mergeState("awaiting_checks", "pipeline_pending");
  if (mr.head_pipeline.status !== "success")
    return mergeState("blocked", "pipeline_failed");
  if (mr.detailed_merge_status !== "mergeable")
    return mergeState("blocked", "merge_restrictions");
  return mergeState("ready", "provider_ready");
}

/** Submit the SHA-guarded native operation and require positive, revision-bound readback. */
export async function scheduleGitlabMerge(
  transport: HttpForgeTransport,
  projectRoute: string,
  request: ForgeMergeRequest,
  checkpoint?: ForgeMergeCheckpoint,
): Promise<"scheduled" | "merged"> {
  if (request.writeStage && request.writeStage !== "prepared")
    throw new ForgeOperationError("unsupported", true);
  const state = await inspectGitlabMerge(transport, projectRoute, request);
  requireMergeReady(state);
  const actor = z
    .object({ id: mergeId })
    .parse(await transport.request("user"));
  const response = await sendMergeMutation(
    checkpoint,
    "prepared",
    "submitting",
    () =>
      transport.request(
        `projects/${request.externalRepositoryId}/merge_requests/${request.number}/merge`,
        "PUT",
        {
          auto_merge: true,
          sha: request.headSha,
          squash: request.method === "squash",
        },
      ),
  );
  try {
    // Only a response to this authenticated PUT can supply the missing attribution.
    // An unsolicited GET with a null scheduler cannot acknowledge our request.
    const parsed = mrSchema.safeParse(response);
    const mr = parsed.data;
    let observedRequest = request;
    if (
      mr &&
      mr.iid === String(request.number) &&
      mr.project_id === request.externalRepositoryId &&
      mr.sha === request.headSha &&
      mr.target_branch === request.baseBranch &&
      mr.state === "opened" &&
      mr.merge_when_pipeline_succeeds
    ) {
      if (!mr.merge_user || mr.merge_user.id === actor.id) {
        await checkpoint?.("acknowledged");
        observedRequest = { ...request, writeStage: "acknowledged" };
      }
    }
    const observed = await inspectGitlabMerge(
      transport,
      projectRoute,
      observedRequest,
    );
    if (observed.state === "scheduled" || observed.state === "merged")
      return observed.state;
  } catch {
    // A read failure after the PUT cannot establish whether it committed.
  }
  throw new ForgeOperationError("unavailable", true);
}
