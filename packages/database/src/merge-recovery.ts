import { and, eq, inArray, sql } from "drizzle-orm";

import type { Forge, ForgeMergeRequest } from "@razbor/forge-adapters";

import type { Database, Transaction } from "@database/src/connection.js";
import { RepositoryManagementError } from "@database/src/repository-lifecycle.js";
import { pullRequests, repositories, reviews } from "@database/src/schema.js";
import { triageForge } from "@database/src/webhooks.js";

type Review = typeof reviews.$inferSelect;

type PullRequest = typeof pullRequests.$inferSelect;

type Repo = typeof repositories.$inferSelect;

/** Bind provider writes to the identified PR, destination, head, policy and reviewed result. */
export function mergeRequest(
  repo: Repo,
  review: Review,
  pr: PullRequest,
): ForgeMergeRequest | undefined {
  const policy = review.source.mergePolicy?.policy;
  if (
    !policy ||
    !review.source.pullRequest ||
    !review.source.baseBranch ||
    !repo.externalRepositoryId
  )
    return;
  return {
    number: pr.number,
    externalRepositoryId: repo.externalRepositoryId,
    headSha: review.headSha,
    baseSha: review.source.pullRequest.baseSha,
    baseBranch: review.source.baseBranch,
    method: policy.mergeMethod,
    requirePassingChecks: policy.requirePassingChecks,
    reviewId: review.publicId,
    writeStage:
      review.mergeWriteStage ??
      (review.mergeAction === "scheduled" ? "acknowledged" : undefined),
  };
}

/**
 * Reconcile the saved operation against provider evidence. A queued or lost first write
 * may still arrive after a negative read, so absence only retires an acknowledged schedule.
 * Record the remote result durably even if a later policy edit or admission rolls back.
 */
export async function retireMerge(
  database: Database,
  repo: Repo,
  pr: PullRequest,
  review: Review,
  resolveApi: () => Promise<Forge>,
) {
  const request = mergeRequest(repo, review, pr);
  if (!request) return false;
  let prior = review.mergeAction;
  if (!prior) return false;
  // Only prepared proves that even the check creation has not been sent.
  const prepared =
    prior !== "scheduled" && review.mergeWriteStage === "prepared";
  const api = prepared ? undefined : await resolveApi();
  const creating = request.writeStage === "creating_check";
  const state = creating ? undefined : await api?.inspectMerge(request);
  const merged = state?.state === "merged";
  if (api && creating) {
    // A delayed POST can still leave a conflicting check on a replacement review's
    // head. Require positive retirement of the check that this checkpoint owns.
    if ((await api.cancelMerge(request)) !== "cancelled") return false;
  } else if (api && !merged && !state?.terminal) {
    const accepted =
      prior === "scheduled" ||
      request.writeStage === "acknowledged" ||
      request.writeStage === "armed" ||
      state?.state === "scheduled" ||
      (request.writeStage === "submitting" && state?.nativeArmed);
    if (!accepted) return false;
    if (prior !== "scheduled") {
      // Commit before cancellation: even an operator removing the native request
      // immediately after this read cannot erase its positive acknowledgement.
      const saved = await database.db
        .update(reviews)
        .set({ mergeAction: "scheduled" })
        .where(
          and(
            eq(reviews.id, review.id),
            eq(reviews.mergeAction, prior),
            sql`${reviews.mergeWriteStage} is not distinct from ${review.mergeWriteStage}`,
          ),
        )
        .returning({ id: reviews.id });
      if (!saved.length) return false;
      prior = "scheduled";
    }
    const cancellation = await api.cancelMerge(request);
    if (cancellation !== "cancelled" && cancellation !== "absent") return false;
  }
  const updated = await database.db
    .update(reviews)
    .set({
      mergeAction: merged ? "merged" : "refused",
      mergeDecision: {
        status: merged ? "merged" : "stale",
        reviewers: [],
        reasons: [
          merged
            ? {
                code: "provider_merged",
                message:
                  "The provider confirmed the reviewed revision was merged.",
              }
            : {
                code: creating
                  ? "eligibility_check_retired"
                  : "schedule_invalidated",
                message: creating
                  ? "GitHub confirmed retirement of the pending eligibility check."
                  : "The previous merge authorization was retired.",
              },
        ],
      },
    })
    .where(
      and(
        eq(reviews.id, review.id),
        eq(reviews.mergeAction, prior),
        sql`${reviews.mergeWriteStage} is not distinct from ${review.mergeWriteStage}`,
      ),
    )
    .returning({ id: reviews.id });
  return updated.length === 1;
}

/** Retire a visible orphan check after a recorded offline retirement or definitive native refusal. */
export async function retireOrphanedCheck(
  database: Database,
  repo: Repo,
  pr: PullRequest,
  request: ForgeMergeRequest,
  reviewId: string,
  api: Forge,
) {
  const [old] = await database.db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.publicId, reviewId),
        eq(reviews.repositoryId, repo.id),
        eq(reviews.mergePullRequestId, pr.id),
        eq(reviews.headSha, request.headSha),
        eq(reviews.mergeAction, "refused"),
        eq(reviews.mergeWriteStage, "creating_check"),
        sql`(
          (${reviews.mergeDecision}->>'status' = 'stale' and ${reviews.mergeDecision}->'reasons'->0->>'code' = 'schedule_invalidated')
          or exists (select 1 from merge_decision_history h where h.review_id = ${reviews.id}
            and h.action = 'refused' and h.decision->'reasons'->0->>'code' = 'native_submission_refused')
        )`,
      ),
    );
  if (
    !old ||
    old.source.baseBranch !== request.baseBranch ||
    old.source.pullRequest?.baseSha !== request.baseSha
  )
    return false;
  return retireMerge(database, repo, pr, old, async () => api);
}

/**
 * Settle all existing native merge authorities before replacing policy or admitting
 * a newer code review. Repository-wide callers hold the owning repository FOR UPDATE;
 * a PR-scoped caller holds its repository FOR SHARE and the current PR FOR UPDATE.
 * Those locks conflict with both scheduling transactions. Remote acknowledgements are
 * independent writes so rollback cannot erase a confirmed cancellation on another PR.
 */
export async function settleMergeAuthority(
  database: Database,
  tx: Transaction,
  repo: Repo,
  prId?: string,
) {
  const active = await tx
    .select({ review: reviews, pr: pullRequests })
    .from(reviews)
    .innerJoin(pullRequests, eq(reviews.mergePullRequestId, pullRequests.id))
    .where(
      and(
        eq(reviews.repositoryId, repo.id),
        prId ? eq(pullRequests.id, prId) : undefined,
        inArray(reviews.mergeAction, ["writing", "scheduled", "uncertain"]),
      ),
    )
    .orderBy(reviews.id);
  if (!active.length) return;
  await tx.execute(sql`set local idle_in_transaction_session_timeout = '90s'`);
  for (const { review, pr } of active) {
    let settled = false;
    try {
      settled = await retireMerge(
        database,
        repo,
        pr,
        review,
        async () => (await triageForge(database, repo.id)).api,
      );
    } catch {
      // Preserve the prior version and write fence when authoritative proof is unavailable.
    }
    if (!settled)
      throw new RepositoryManagementError(
        409,
        `Pull request #${pr.number} has an outstanding or unconfirmed native merge. Resolve it in the provider before retrying.`,
      );
  }
}
