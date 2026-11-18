import { z } from "zod";

import { reviewerUsernameSchema } from "@razbor/contracts";

import { providerId } from "@forge-adapters/src/http.js";
import {
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeCheckpoint,
  type ForgeMergeWriteStage,
  type ForgeMergeState,
} from "@forge-adapters/src/interactions.js";

export const mergeId = providerId.pipe(z.string().regex(/^[1-9]\d*$/));

export const commitSha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

export const mergeRequestSchema = z.object({
  number: z.number().int().positive().safe(),
  externalRepositoryId: z.string().regex(/^[1-9]\d*$/),
  baseSha: commitSha,
  headSha: commitSha,
  baseBranch: z.string().min(1).max(1024),
  method: z.enum(["merge", "squash", "rebase"]),
  requirePassingChecks: z.boolean(),
  reviewId: z.string().regex(/^rev_[A-Za-z0-9]{16}$/),
});

/** Compare both immutable revisions and the destination before any open PR operation. */
export function differentRevision(
  request: ForgeMergeRequest,
  head: string,
  base: string,
  branch: string,
) {
  return (
    head !== request.headSha ||
    base !== request.baseSha ||
    branch !== request.baseBranch
  );
}

const mergeReasons = {
  shared_head_check:
    "GitHub could not establish that this PR is the only open request using the reviewed head. A commit-wide eligibility check could release another PR.",
  app_pinned_strict_check_required:
    "Require strict, administrator-enforced default-branch protection and pin the Razbor eligibility check to this GitHub App.",
  conflicting_eligibility_check:
    "This commit already has an eligibility check for another review. Inspect the existing check before using a fresh revision.",
  destination_changed:
    "The provider's repository or default branch has changed since this review.",
  direct_child_required:
    "This native operation requires a single-parent head commit directly on the reviewed destination tip.",
  exclusive_destination_required:
    "The provider cannot confirm that this automation identity can merge only into the default branch.",
  existing_schedule:
    "The provider already has a merge schedule that this review does not own.",
  forgejo_schedule_does_not_pin_reviewed_head:
    "Forgejo's native scheduler discards the reviewed head SHA. A maintainer must merge this PR.",
  eligibility_check_unconfirmed:
    "GitHub has no visible eligibility check for this review. Razbor will resume if it appears. If GitHub verifies the request was never accepted and cannot arrive, follow the operator recovery procedure in docs/merge-providers.md, then request a new review.",
  conversation_resolution_required:
    "Require resolution of all review conversations in the default branch protection or an active pull request ruleset that this App cannot bypass.",
  immutable_source_required:
    "GitHub requires a locked source branch in this repository with force pushes, deletions and fork syncing disabled.",
  installed_github_app_required:
    "Install or reconnect the repository's GitHub App so Razbor can verify the source of its eligibility check.",
  merge_method_unavailable:
    "The selected merge method is unavailable with this project's merge and squash settings.",
  merge_restrictions:
    "The provider reports an outstanding merge restriction. Check approvals, conversations, conflicts and native merge requirements.",
  native_auto_merge_unavailable:
    "GitHub reports that the installed App cannot enable native auto-merge for this PR.",
  not_open_ready:
    "Automatic merging requires an open PR that is ready for review.",
  pipeline_failed: "The pipeline for the reviewed commit did not succeed.",
  pipeline_pending:
    "A successful pipeline for the reviewed commit is still required.",
  project_bot_required:
    "Use a GitLab project bot with the Developer role for guarded merging.",
  protected_successful_pipeline_required:
    "Protect the GitLab target, require a successful pipeline and disable merging after a skipped pipeline.",
  provider_merged: "The provider confirmed the reviewed head was merged.",
  provider_ready:
    "The provider confirmed the revision and native merge requirements.",
  provider_scheduled:
    "The provider confirmed a native merge schedule for the reviewed head.",
  required_check_failed:
    "A required GitHub check finished without a successful conclusion.",
  required_check_pending:
    "A successful GitHub Check Run for every required context is still needed on the reviewed commit.",
  retired_eligibility_check:
    "The existing GitHub eligibility check has already finished and cannot authorize this operation.",
  revision_changed:
    "The provider's PR identity, destination or reviewed revision has changed.",
  unowned_schedule:
    "An existing GitHub auto-merge request has no eligibility check belonging to this review.",
  unsupported_github_merge_strategy:
    "Enable the selected native GitHub merge method on a supported default branch. Merge-queue targets require a human.",
  unsupported_gitlab_merge_strategy:
    "This GitLab version or strategy cannot enforce the revision guard. Use semi-linear or fast-forward merging with merge trains and automatic rebase off.",
  verification_check_required:
    "Configure a required GitHub verification check in addition to Razbor's eligibility check.",
} as const;

/** Translate a persisted provider reason to administrator-facing text without rendering remote payloads. */
export function forgeMergeReason(code: string) {
  return Object.hasOwn(mergeReasons, code)
    ? mergeReasons[code as keyof typeof mergeReasons]
    : "The provider could not verify all required merge conditions.";
}

/** Supply a stable reason code suitable for recording in the decision history. */
export function mergeState(
  state: ForgeMergeState["state"],
  reason: keyof typeof mergeReasons,
): ForgeMergeState {
  return { state, reason };
}

/** Perform a single account lookup and suppress missing, reserved, non-person or unavailable identities. */
export async function resolveReviewer(
  username: string,
  lookup: (escaped: string) => Promise<string | undefined>,
) {
  if (!reviewerUsernameSchema.safeParse(username).success) return null;
  try {
    const found = await lookup(encodeURIComponent(username));
    return found?.toLowerCase() === username.toLowerCase() ? found : null;
  } catch {
    return null;
  }
}

/** A stale or denied preflight must never reach a mutation. */
export function requireMergeReady(state: ForgeMergeState) {
  if (state.state !== "ready") throw new ForgeOperationError("unsupported");
}

/** Persist a send boundary and restore its prior proof if the transport positively refused dispatch. */
export async function sendMergeMutation(
  checkpoint: ForgeMergeCheckpoint | undefined,
  previous: ForgeMergeWriteStage,
  next: ForgeMergeWriteStage,
  send: () => Promise<unknown>,
) {
  await checkpoint?.(next);
  try {
    return await send();
  } catch (error) {
    // The transport distinguishes a deadline before fetch from a lost response.
    // A definitive 4xx on the native submission remains a recorded refusal.
    if (
      error instanceof ForgeOperationError &&
      !error.uncertain &&
      (error.status === undefined ||
        error.retryAt !== undefined ||
        next !== "submitting")
    )
      await checkpoint?.(previous);
    throw error;
  }
}
