import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  evaluateMergeDecision,
  type MergeDecisionInput,
  type ReviewApprovalStatus,
} from "@razbor/contracts";
import {
  ForgeOperationError,
  type ForgeMergeRequest,
} from "@razbor/forge-adapters";

import type { Database } from "@database/src/connection.js";
import { withCurrentMergeReview } from "@database/src/merge-policy.js";
import { hasRetiringApproval } from "@database/src/merge-recovery.js";
import { pullRequests, repositories, reviews } from "@database/src/schema.js";
import type { triageForge } from "@database/src/webhooks.js";

type ApprovalResult = { status: ReviewApprovalStatus; retryAt?: Date };

/** Cast at most one exact-head vote. A lost write can only be reconciled by reading the forge. */
export async function syncReviewApproval(
  database: Database,
  repo: typeof repositories.$inferSelect,
  pr: typeof pullRequests.$inferSelect,
  review: typeof reviews.$inferSelect,
  request: ForgeMergeRequest,
  input: MergeDecisionInput,
  { api, bot }: Awaited<ReturnType<typeof triageForge>>,
  reconcileOnly: boolean,
): Promise<ApprovalResult | undefined> {
  return withCurrentMergeReview(database, repo, pr, review, async (tx) => {
    if (await hasRetiringApproval(tx, pr.id)) return { status: "unavailable" };
    // A fresh review on the same head must not duplicate a late vote, restore a
    // withdrawn vote or count a different installation as a second approver.
    const [previous] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.mergePullRequestId, pr.id),
          eq(reviews.headSha, request.headSha),
          inArray(sql<string>`${reviews.forgeApproval}->>'status'`, [
            "uncertain",
            "approved",
            "dismissed",
          ]),
        ),
      )
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(1);
    const owner = previous ?? review;
    const saved = owner.forgeApproval;
    if (reconcileOnly && !saved) return { status: "unavailable" };
    if (
      saved &&
      (saved.botId !== bot.id ||
        owner.source.pullRequest?.baseSha !== request.baseSha ||
        owner.source.baseBranch !== request.baseBranch)
    )
      return { status: "unavailable" };
    if (saved?.status === "dismissed" || saved?.status === "unavailable")
      return { status: saved.status };
    const vote = { ...request, reviewId: owner.publicId };
    let uncertain = saved?.status === "uncertain";
    try {
      if (!saved) {
        const state = await api.inspectApproval(request, bot);
        if (state.state !== "ready")
          return {
            status: "unavailable",
            retryAt:
              state.state === "awaiting_checks"
                ? new Date(Date.now() + 60_000)
                : undefined,
          };
        // A ready approval preflight verified checks and restrictions for a vote.
        // These facts are never passed to the native merge dispatcher.
        const local = evaluateMergeDecision({
          ...input,
          provider: {
            guarded: true,
            checks: "passing",
            restrictions: "satisfied",
          },
        });
        if (local.status !== "auto_merge_eligible") return;
      }
      const result = await api.approveReview(
        vote,
        bot,
        Boolean(saved),
        async () => {
          // This commit survives a later disconnect or rollback of the lock holder.
          const claimed = await database.db
            .update(reviews)
            .set({ forgeApproval: { botId: bot.id, status: "uncertain" } })
            .where(
              and(
                eq(reviews.id, owner.id),
                sql`${reviews.forgeApproval} is null`,
              ),
            )
            .returning({ id: reviews.id });
          if (!claimed.length) throw new Error("Approval ownership changed");
          uncertain = true;
        },
        saved?.status === "approved",
      );
      let status: ReviewApprovalStatus;
      if (result === "approved" || result === "dismissed") status = result;
      else if (uncertain)
        return {
          status: "uncertain",
          retryAt: new Date(Date.now() + 3_600_000),
        };
      else if (result === "absent" && saved?.status === "approved")
        status = "dismissed";
      else return { status: "unavailable" };
      await tx
        .update(reviews)
        .set({ forgeApproval: { botId: bot.id, status } })
        .where(eq(reviews.id, owner.id));
      return { status };
    } catch (error) {
      if (
        !saved &&
        error instanceof ForgeOperationError &&
        error.definitelyRefused
      ) {
        const retryable =
          error.reason === "not-sent" ||
          error.retryAt !== undefined ||
          error.status === 429;
        if (uncertain) {
          // Only this attempt's unsent or definitively refused vote can release its intent.
          await tx
            .update(reviews)
            .set({
              forgeApproval: retryable
                ? null
                : { botId: bot.id, status: "unavailable" },
            })
            .where(eq(reviews.id, owner.id));
        }
        return {
          status: "unavailable",
          retryAt: retryable
            ? new Date(error.retryAt ?? Date.now() + 60_000)
            : undefined,
        };
      }
      return {
        status: uncertain ? "uncertain" : "unavailable",
        retryAt: new Date(
          Math.max(
            Date.now() + (uncertain ? 3_600_000 : 60_000),
            error instanceof ForgeOperationError ? (error.retryAt ?? 0) : 0,
          ),
        ),
      };
    }
  });
}
