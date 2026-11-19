import { and, eq, inArray, sql } from "drizzle-orm";

import {
  ForgeOperationError,
  type Forge,
  type ForgeMergeRequest,
} from "@razbor/forge-adapters";

import type { Database, Transaction } from "@database/src/connection.js";
import { RepositoryManagementError } from "@database/src/repository-lifecycle.js";
import { pullRequests, repositories, reviews } from "@database/src/schema.js";
import { triageForge } from "@database/src/webhooks.js";

type Review = typeof reviews.$inferSelect;

type PullRequest = typeof pullRequests.$inferSelect;

type Repo = typeof repositories.$inferSelect;

type Approval = NonNullable<Review["forgeApproval"]>;

/** A lost GitLab unapprove can affect a later head, so fence the entire PR. */
export async function hasRetiringApproval(tx: Transaction, prId: string) {
  const [pending] = await tx
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(
        eq(reviews.mergePullRequestId, prId),
        sql`${reviews.forgeApproval}->>'retiring' = 'true'`,
      ),
    )
    .limit(1);
  return Boolean(pending);
}

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

/** Commit withdrawal checkpoints independently of an enclosing policy save or triage transaction.
 * The caller holds the repository write lock or the repository and current PR locks.
 */
async function withdrawApproval(
  database: Database,
  tx: Transaction,
  repo: Repo,
  pr: PullRequest,
  review: Review,
  receipt: Approval,
) {
  let saved = receipt;
  /** Compare against the durable operation that authorized this update. */
  async function persist(value: Approval) {
    const [row] = await database.db
      .update(reviews)
      .set({ forgeApproval: value })
      .where(and(eq(reviews.id, review.id), eq(reviews.forgeApproval, saved)))
      .returning({ id: reviews.id });
    if (!row) throw new Error("Approval withdrawal ownership changed");
    saved = value;
  }
  // Each receipt gets its own HTTP budget. Verify the enclosing lock holder is
  // still alive between receipts and immediately before sending a withdrawal.
  await tx.execute(sql`select 1`);
  if (!saved.retiring) await persist({ ...saved, retiring: true });
  if (saved.retireAfter && saved.retireAfter > Date.now()) return false;
  const request = mergeRequest(repo, review, pr);
  if (!request) return false;
  let sentHere = false;
  try {
    const { api, bot } = await triageForge(database, repo.id);
    if (bot.id !== saved.botId) return false;
    const result = await api.retireApproval(
      request,
      bot,
      saved.status === "approved",
      async () => {
        await tx.execute(sql`select 1`);
        if (!saved.retirementSent)
          await persist({ ...saved, retirementSent: true });
        sentHere = true;
      },
      saved.retirementSent === true,
    );
    if (result !== "retired") return false;
    await persist({ botId: saved.botId, status: "dismissed" });
    return true;
  } catch (error) {
    if (error instanceof ForgeOperationError && !error.uncertain) {
      // A refusal of this call cannot discharge an earlier ambiguous withdrawal.
      const rejected =
        sentHere &&
        !receipt.retirementSent &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500;
      if (rejected || error.retryAt !== undefined)
        await persist({
          ...saved,
          retirementSent: rejected ? undefined : saved.retirementSent,
          retireAfter: error.retryAt,
        });
    }
    return false;
  }
}

/** Withdraw obsolete owned votes under the caller's locks; return the first PR still carrying possible authority. */
export async function retireReviewApprovals(
  database: Database,
  tx: Transaction,
  repo: Repo,
  prId: string | undefined,
  withdrawAll: boolean,
) {
  const rows = await tx
    .select({ review: reviews, pr: pullRequests })
    .from(reviews)
    .innerJoin(pullRequests, eq(reviews.mergePullRequestId, pullRequests.id))
    .where(
      and(
        eq(reviews.repositoryId, repo.id),
        prId ? eq(pullRequests.id, prId) : undefined,
        inArray(sql<string>`${reviews.forgeApproval}->>'status'`, [
          "approved",
          "uncertain",
        ]),
      ),
    )
    .orderBy(reviews.id);
  let pending: number | undefined;
  for (const { review, pr } of rows) {
    const receipt = review.forgeApproval;
    if (!receipt) continue;
    if (
      !withdrawAll &&
      !receipt.retiring &&
      !pr.humanEscalated &&
      repo.mergePolicy.enabled &&
      repo.mergePolicy.autoApprove &&
      review.source.mergePolicy?.version === repo.mergePolicyVersion &&
      review.headSha === pr.headSha &&
      review.source.baseBranch === pr.baseBranch &&
      review.source.pullRequest?.baseSha === pr.baseSha
    )
      continue;
    // A repository-wide edit can roll back or die after the remote write. Wake
    // even a previously idle PR so its comment and withdrawal are reconciled.
    // A triage worker already owns this row and has committed its claim deadline.
    if (!prId)
      await database.db
        .update(pullRequests)
        .set({
          mergeAfter: sql`least(${pullRequests.mergeAfter}, now() + interval '1 minute')`,
        })
        .where(eq(pullRequests.id, pr.id));
    if (!(await withdrawApproval(database, tx, repo, pr, review, receipt)))
      pending ??= pr.number;
  }
  return pending;
}

/**
 * Settle outstanding native merge requests before changing the policy or source
 * binding or admitting a newer code review. Repository-wide callers hold the owning
 * repository FOR UPDATE. A PR-scoped caller holds its repository FOR SHARE and the
 * current PR FOR UPDATE.
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
  await tx.execute(sql`set local idle_in_transaction_session_timeout = '90s'`);
  for (const { review, pr } of active) {
    await tx.execute(sql`select 1`);
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
  // A replacement review on the same head can adopt a still-valid vote. A
  // policy/source edit or deletion must settle every vote under the old binding.
  if (!prId) {
    const pending = await retireReviewApprovals(
      database,
      tx,
      repo,
      undefined,
      true,
    );
    if (pending !== undefined)
      throw new RepositoryManagementError(
        409,
        `Pull request #${pending} has an unconfirmed approval withdrawal. Resolve the bot vote in the provider before retrying.`,
      );
  }
}
