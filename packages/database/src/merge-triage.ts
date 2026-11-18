import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";

import {
  evaluateMergeDecision,
  type MergeDecision,
  type MergeDecisionInput,
} from "@razbor/contracts";
import {
  forgeMergeReason,
  ForgeOperationError,
  type ForgeMergeRequest,
  type ForgeMergeWriteStage,
  type ForgeMergeState,
} from "@razbor/forge-adapters";
import { logger } from "@razbor/harness/logger";

import type { Database } from "@database/src/connection.js";
import { syncEscalation } from "@database/src/merge-escalation.js";
import {
  latestMergeReview,
  withCurrentMergeReview,
} from "@database/src/merge-policy.js";
import {
  mergeRequest,
  retireMerge,
  retireOrphanedCheck,
} from "@database/src/merge-recovery.js";
import {
  dispatchOutbox,
  pullRequests,
  repositories,
  reviews,
} from "@database/src/schema.js";
import {
  interactionLock,
  triageForge,
  triageOutstanding,
} from "@database/src/webhooks.js";

type Review = typeof reviews.$inferSelect;

type PullRequest = typeof pullRequests.$inferSelect;

type Repo = typeof repositories.$inferSelect;

type ProviderClient = Awaited<ReturnType<typeof triageForge>>;

const retryMs = 30000;

/** Describe a server or provider condition without storing raw provider errors. */
function reason(
  status: MergeDecision["status"],
  code: string,
  message: string,
): MergeDecision {
  return { status, reasons: [{ code, message }], reviewers: [] };
}

/** Map verified provider capability and protection observations into the shared engine's facts. */
function providerFacts(state: ForgeMergeState): MergeDecisionInput["provider"] {
  const pending = state.state === "awaiting_checks";
  const guarded = ["ready", "scheduled", "merged", "awaiting_checks"].includes(
    state.state,
  );
  return {
    guarded,
    checks: pending ? "pending" : guarded ? "passing" : "unknown",
    restrictions: pending ? "pending" : guarded ? "satisfied" : "blocked",
    reason: forgeMergeReason(state.reason),
    merged: state.state === "merged",
  };
}

/** Execute a previously armed write under revision and policy locks, retaining ambiguous outcomes for readback. */
async function writeGuardedMerge(
  database: Database,
  repo: Repo,
  pr: PullRequest,
  review: Review,
  decision: MergeDecision,
  request: ForgeMergeRequest,
  resumeOnly: boolean,
  botId: string,
) {
  let stage = request.writeStage;
  let submittedHere = false;
  let submittedFromCheck = false;
  try {
    const { api, bot } = await triageForge(database, repo.id);
    if (bot.id !== botId) throw new ForgeOperationError("permission");
    const sent = await withCurrentMergeReview(
      database,
      repo,
      pr,
      review,
      async (tx) => {
        // The repository/PR locks serialize admission and dispatch. Leave the review
        // row unlocked so each checkpoint commits even if this transaction is lost.
        const [armed] = await tx
          .select({ stage: reviews.mergeWriteStage })
          .from(reviews)
          .where(
            and(eq(reviews.id, review.id), eq(reviews.mergeAction, "writing")),
          );
        if (!armed || armed.stage !== stage) return false;
        /** Durably fence every mutating step before sending its HTTP request. */
        async function checkpoint(next: ForgeMergeWriteStage) {
          const changed = await database.db
            .update(reviews)
            .set({ mergeWriteStage: next })
            .where(
              and(
                eq(reviews.id, review.id),
                eq(reviews.mergeAction, "writing"),
                sql`${reviews.mergeWriteStage} is not distinct from ${stage ?? null}`,
              ),
            )
            .returning({ id: reviews.id });
          if (!changed.length) throw new Error("Merge write boundary changed");
          if (next === "submitting") {
            submittedHere = true;
            submittedFromCheck = stage === "creating_check";
          }
          stage = next;
        }
        const result = await api.scheduleMerge(request, resumeOnly, checkpoint);
        await tx
          .update(reviews)
          .set({
            mergeAction: result,
            mergeDecision:
              result === "merged"
                ? reason(
                    "merged",
                    "provider_merged",
                    "The provider confirmed the reviewed revision was merged.",
                  )
                : decision,
          })
          .where(eq(reviews.id, review.id));
        return true;
      },
    );
    if (sent || stage !== "prepared") return;
    await database.db
      .update(reviews)
      .set({
        mergeAction: "refused",
        mergeDecision: reason(
          "stale",
          "schedule_superseded",
          "The review was superseded before the merge request.",
        ),
      })
      .where(
        and(
          eq(reviews.id, review.id),
          eq(reviews.mergeAction, "writing"),
          eq(reviews.mergeWriteStage, "prepared"),
        ),
      );
  } catch (error) {
    if (
      error instanceof ForgeOperationError &&
      !error.uncertain &&
      error.retryAt !== undefined
    ) {
      const retryAt = new Date(error.retryAt);
      await withCurrentMergeReview(database, repo, pr, review, async (tx) => {
        const saved = await tx
          .update(reviews)
          .set({
            mergeDecision: reason(
              "blocked",
              "provider_rate_limited",
              `GitHub rate-limited the request. Razbor will retry after ${retryAt.toISOString()}.`,
            ),
          })
          .where(
            and(
              eq(reviews.id, review.id),
              eq(reviews.mergeAction, "writing"),
              sql`${reviews.mergeWriteStage} is not distinct from ${stage ?? null}`,
            ),
          )
          .returning({ id: reviews.id });
        if (saved.length)
          await tx
            .update(pullRequests)
            .set({ mergeAfter: retryAt })
            .where(eq(pullRequests.id, pr.id));
      });
      return;
    }
    // A pre-native lookup or pending-check failure leaves a retryable boundary.
    // A known refusal belongs to the submission in THIS call, never an older
    // ambiguous release or enable which a later read happened to reject.
    const preNative = stage === "prepared" || stage === "creating_check";
    const refused =
      submittedHere &&
      stage === "submitting" &&
      error instanceof ForgeOperationError &&
      !error.uncertain &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500;
    await database.db
      .update(reviews)
      .set({
        mergeAction: preNative ? "writing" : refused ? "refused" : "uncertain",
        // GitHub rejected this submission, leaving only its existing pending check.
        mergeWriteStage:
          refused && submittedFromCheck ? "creating_check" : undefined,
        mergeDecision: reason(
          "blocked",
          preNative
            ? "provider_unavailable"
            : refused
              ? "native_submission_refused"
              : "write_uncertain",
          preNative
            ? "The provider could not finish preparing this merge. Razbor will retry."
            : refused
              ? "The provider refused the guarded merge request."
              : "The provider may have received the merge request. Reconciliation is pending.",
        ),
      })
      .where(
        and(
          eq(reviews.id, review.id),
          eq(reviews.mergeAction, "writing"),
          sql`${reviews.mergeWriteStage} is not distinct from ${stage ?? null}`,
        ),
      );
  }
}

/** Keep checking closed or resolved comments while a provider write could still arrive. */
function nextEscalationCheck(human: boolean) {
  return human
    ? new Date(Date.now() + 600_000)
    : sql`case when
    coalesce((${pullRequests.escalationComment}->>'pendingReservations')::integer,0) > 0
    or ${pullRequests.escalationComment}->>'uncertainEdit' = 'true'
    then now() + interval '1 hour' else null end`;
}

/** Process one due PR under its publication lock, persisting the write intent independently of the response. */
async function triagePullRequest(database: Database, prId: string) {
  const [row] = await database.db
    .select({ repo: repositories, pr: pullRequests })
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .where(
      and(
        eq(pullRequests.id, prId),
        lte(pullRequests.mergeAfter, new Date()),
        eq(repositories.status, "active"),
      ),
    );
  if (!row) return;
  const { pr, repo } = row;
  // On process death, the deadline reopens the worker without dropping a stored write fence.
  const claim = await database.db
    .update(pullRequests)
    .set({ mergeAfter: new Date(Date.now() + retryMs) })
    .where(
      and(
        eq(pullRequests.id, prId),
        eq(pullRequests.mergeRevision, pr.mergeRevision),
        lte(pullRequests.mergeAfter, new Date()),
      ),
    )
    .returning({ id: pullRequests.id });
  if (!claim.length) return;
  const [entry] = await latestMergeReview(database.db, prId);
  if (!entry) {
    await database.db
      .update(pullRequests)
      .set({ mergeAfter: null })
      .where(
        and(
          eq(pullRequests.id, prId),
          sql`not exists (select 1 from reviews where merge_pull_request_id = ${prId})`,
        ),
      );
    return;
  }
  const { review, publication, trigger } = entry;
  if (review.mergeAction === "merged") {
    if (pr.escalationComment && review.source.mergePolicy) {
      try {
        await syncEscalation(
          database,
          repo,
          pr,
          review,
          reason(
            "merged",
            "provider_merged",
            "The provider confirmed the reviewed revision was merged.",
          ),
          await triageForge(database, repo.id),
        );
      } catch (error) {
        // The claim deadline retries this PR while other repositories can continue.
        logger.warn(
          {
            reviewId: review.publicId,
            reason:
              error instanceof ForgeOperationError
                ? error.reason
                : "unavailable",
          },
          "merged PR comment reconciliation deferred",
        );
        return;
      }
    }
    await withCurrentMergeReview(database, repo, pr, review, async (tx) => {
      await tx
        .update(pullRequests)
        .set({ mergeAfter: nextEscalationCheck(false) })
        .where(eq(pullRequests.id, pr.id));
    });
    return;
  }
  const snapshot = review.source.mergePolicy;
  const request = mergeRequest(repo, review, pr);
  const input: MergeDecisionInput = {
    snapshot,
    currentPolicyVersion: repo.mergePolicyVersion,
    reviewStatus: review.status,
    result: review.result,
    // The recap's outstanding count is a publication-time observation. Recheck
    // the saved identities and current provider threads before using that count for triage.
    outstandingFindings: 0,
    revisionCurrent:
      review.headSha === pr.headSha &&
      (review.source.pullRequest?.baseSha ?? trigger?.baseSha) === pr.baseSha &&
      (!snapshot ||
        (review.source.mergeRevision === pr.mergeRevision &&
          review.source.baseBranch === (pr.baseBranch ?? undefined))),
    open: pr.state === "open",
    draft: pr.draft === true,
    baseBranch: pr.baseBranch,
    defaultBranch: repo.observed?.defaultBranch,
    humanEscalated: pr.humanEscalated,
    // This local pass only determines which facts still need provider verification.
    provider: { guarded: false, checks: "unknown", restrictions: "unknown" },
  };
  let decision = evaluateMergeDecision(input);
  const onlyHistoricalChecks =
    decision.reasons.length === 1 &&
    decision.reasons[0]?.code === "outstanding_findings";
  let action: Review["mergeAction"] = review.mergeAction;
  let retry = decision.status === "review_in_progress";
  let client: ProviderClient | undefined;
  let state: ForgeMergeState | undefined;
  /** Resolve the trusted forge identity lazily, including console-triggered reviews without a webhook. */
  async function provider() {
    return (client ??= await triageForge(database, repo.id));
  }
  const active = ["scheduled", "uncertain", "writing"] as const;
  const fenced = active.some((v) => v === action);
  const older = await database.db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.mergePullRequestId, pr.id),
        ne(reviews.id, review.id),
        inArray(reviews.mergeAction, [...active]),
      ),
    );
  try {
    for (const old of older) {
      let retired = false;
      try {
        retired = await retireMerge(
          database,
          repo,
          pr,
          old,
          async () => (await provider()).api,
        );
      } catch (error) {
        logger.warn(
          {
            reviewId: old.publicId,
            reason:
              error instanceof ForgeOperationError
                ? error.reason
                : "unavailable",
          },
          "older merge reconciliation deferred",
        );
      }
      if (!retired) {
        decision = reason(
          "blocked",
          "prior_write_uncertain",
          "An older native merge request requires provider reconciliation.",
        );
        retry = true;
        break;
      }
    }
    if (decision.reasons[0]?.code === "prior_write_uncertain") {
      await withCurrentMergeReview(database, repo, pr, review, async (tx) => {
        await tx
          .update(reviews)
          .set({ mergeDecision: decision })
          .where(eq(reviews.id, review.id));
      });
      return;
    }
    if (
      fenced &&
      (decision.status === "stale" ||
        !input.open ||
        input.draft ||
        pr.humanEscalated)
    ) {
      if (
        await retireMerge(
          database,
          repo,
          pr,
          review,
          async () => (await provider()).api,
        )
      )
        return;
      decision = reason(
        "blocked",
        "write_uncertain",
        "An obsolete native merge request requires provider reconciliation.",
      );
      retry = true;
    } else if (
      decision.reasons[0]?.code === "guard_unavailable" ||
      onlyHistoricalChecks ||
      fenced
    ) {
      if (!request || !snapshot || !repo.verifiedAt) {
        decision = reason(
          "blocked",
          "provider_binding_missing",
          "A verified repository and a saved destination branch are required.",
        );
      } else if (trigger && publication?.state !== "published" && !fenced) {
        decision = reason(
          publication?.stale || publication?.state === "stale"
            ? "stale"
            : "blocked",
          "publication_incomplete",
          "Finding publication and reconciliation must finish before merging.",
        );
        retry = decision.status !== "stale";
      } else if (publication?.rearmed || publication?.stale) {
        decision = reason(
          "stale",
          "publication_superseded",
          "Request a new review of the current revision.",
        );
      } else {
        const { api, bot } = await provider();
        const prior = await database.db
          .select({ id: reviews.id })
          .from(reviews)
          .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
          .where(
            and(
              eq(reviews.mergePullRequestId, pr.id),
              ne(reviews.id, review.id),
              sql`jsonb_array_length(${reviews.result}->'findings') > 0
              and ${dispatchOutbox.publication}->>'state' is distinct from 'published'`,
            ),
          )
          .limit(1);
        input.outstandingFindings =
          prior.length +
          (await triageOutstanding(
            database,
            repo.id,
            pr.number,
            bot.id,
            api,
            review,
          ));
        state = await api.inspectMerge(request);
        const pendingReview = state.pendingCheckReviewId;
        if (
          !fenced &&
          snapshot.version === repo.mergePolicyVersion &&
          !snapshot.policy.dryRun &&
          !input.outstandingFindings &&
          pendingReview &&
          (await withCurrentMergeReview(database, repo, pr, review, () =>
            retireOrphanedCheck(
              database,
              repo,
              pr,
              request,
              pendingReview,
              api,
            ),
          ))
        ) {
          // Retiring an old check grants no authority. Recheck all provider requirements.
          state = await api.inspectMerge(request);
        }
        input.outstandingFindingsAudited = true;
        input.provider = providerFacts(state);
        if (state.state === "stale") input.revisionCurrent = false;
        decision = evaluateMergeDecision(input);
        if (["blocked", "awaiting_checks"].includes(decision.status))
          decision.reasons = [
            { code: state.reason, message: forgeMergeReason(state.reason) },
          ];
        if (decision.status === "human_review_required" && fenced) {
          const retired = await retireMerge(
            database,
            repo,
            pr,
            review,
            async () => api,
          );
          if (retired) return;
          if (action !== "scheduled") action = "uncertain";
          decision.reasons.push({
            code: "write_uncertain",
            message:
              "Check the existing native schedule in the provider before merging.",
          });
        } else if (state.state === "merged") action = "merged";
        else if (
          state.state === "scheduled" &&
          fenced &&
          review.mergeWriteStage !== "prepared" &&
          review.mergeWriteStage !== "creating_check"
        )
          action = "scheduled";
        else if (
          state.state === "scheduled" ||
          ((state.resume || state.nativeArmed) && !fenced)
        )
          decision = reason(
            "blocked",
            "existing_schedule",
            "The provider already has a merge request outside this review.",
          );
        else if (fenced && state.reason === "eligibility_check_unconfirmed") {
          action = "uncertain";
          decision = reason(
            "blocked",
            state.reason,
            forgeMergeReason(state.reason),
          );
        } else if (
          fenced &&
          state.resume !== true &&
          review.mergeWriteStage !== "prepared"
        ) {
          // Keep positive admission evidence across an operator's cancellation. A
          // negative read can retire an acknowledged schedule, never a lost first write.
          if (
            (action === "scheduled" ||
              state.terminal ||
              review.mergeWriteStage === "acknowledged" ||
              review.mergeWriteStage === "armed") &&
            (await retireMerge(database, repo, pr, review, async () => api))
          )
            return;
          decision = reason(
            "blocked",
            "write_uncertain",
            "The native merge outcome is unconfirmed. Razbor will check again without issuing another merge.",
          );
          if (action !== "scheduled") action = "uncertain";
        }
        retry = !["merged", "human_review_required", "stale"].includes(
          decision.status,
        );
      }
    }
    if (action === "refused" && decision.status === "auto_merge_eligible") {
      decision = reason(
        "blocked",
        "merge_refused",
        "The provider declined the guarded merge. Request another review after resolving the refusal.",
      );
      retry = false;
    }
    if (action === "dry_run" && decision.status !== "auto_merge_eligible")
      action = null;
    if (decision.status === "auto_merge_eligible" && snapshot?.policy.dryRun)
      action = "dry_run";
    let human =
      decision.status === "human_review_required" &&
      snapshot?.policy.enabled &&
      snapshot.version === repo.mergePolicyVersion;
    if (human) {
      try {
        const fresh = await (await provider()).api.change(pr.number);
        if (
          fresh.headSha !== review.headSha ||
          fresh.baseSha !== review.source.pullRequest?.baseSha ||
          fresh.baseBranch !== review.source.baseBranch ||
          fresh.draft !== false
        ) {
          decision = reason(
            "stale",
            "remote_revision_changed",
            "The provider revision or draft state changed. A current review is required.",
          );
          human = false;
        }
      } catch (error) {
        human = false;
        retry = true;
        decision =
          error instanceof ForgeOperationError &&
          error.reason === "change-closed"
            ? reason(
                "stale",
                "change_closed",
                "The provider reports that the pull request has closed.",
              )
            : reason(
                "blocked",
                "provider_unavailable",
                "The provider could not confirm the revision for human escalation.",
              );
      }
    }
    const send =
      decision.status === "auto_merge_eligible" &&
      action !== "dry_run" &&
      action !== "scheduled" &&
      state?.state === "ready";
    const writeStage = !fenced && send ? "prepared" : review.mergeWriteStage;
    if (send) action = "writing";
    const saved = await withCurrentMergeReview(
      database,
      repo,
      pr,
      review,
      async (tx) => {
        const updated = await tx
          .update(reviews)
          .set({
            mergeDecision: decision,
            mergeAction: action,
            mergeWriteStage: writeStage,
          })
          .where(
            and(
              eq(reviews.id, review.id),
              sql`${reviews.mergeAction} is not distinct from ${review.mergeAction}`,
              sql`${reviews.mergeWriteStage} is not distinct from ${review.mergeWriteStage}`,
            ),
          )
          .returning({ id: reviews.id });
        if (!updated.length) return false;
        await tx
          .update(pullRequests)
          .set({
            ...(human ? { humanEscalated: true } : {}),
            mergeAfter:
              retry || human || pr.escalationComment
                ? new Date(Date.now() + retryMs)
                : null,
          })
          .where(eq(pullRequests.id, pr.id));
        return true;
      },
    );
    if (!saved) return;
    if (send && request && client)
      await writeGuardedMerge(
        database,
        repo,
        pr,
        review,
        decision,
        { ...request, writeStage: writeStage ?? undefined },
        !!state?.resume,
        client.bot.id,
      );
    if ((human || pr.escalationComment) && snapshot) {
      const remote = await provider();
      await syncEscalation(database, repo, pr, review, decision, remote);
      if (!retry && action !== "uncertain")
        await withCurrentMergeReview(database, repo, pr, review, async (tx) => {
          await tx
            .update(pullRequests)
            .set({ mergeAfter: nextEscalationCheck(Boolean(human)) })
            .where(eq(pullRequests.id, pr.id));
        });
    }
  } catch (error) {
    if (
      !fenced &&
      (decision.reasons[0]?.code === "guard_unavailable" ||
        (onlyHistoricalChecks && !input.outstandingFindingsAudited))
    )
      await withCurrentMergeReview(database, repo, pr, review, async (tx) => {
        await tx
          .update(reviews)
          .set({
            mergeDecision: reason(
              "blocked",
              "provider_unavailable",
              "Provider identity, finding history or merge requirements could not be verified.",
            ),
          })
          .where(eq(reviews.id, review.id));
      });
    logger.warn(
      {
        reviewId: review.publicId,
        reason:
          error instanceof ForgeOperationError ? error.reason : "unavailable",
      },
      "merge triage deferred",
    );
  }
}

/** Drain due PRs fairly. Native merge and escalation writes serialize with publication and other workers. */
export async function processMergeTriage(database: Database) {
  // Publication locks are per repository. Give each due repository a slot before
  // considering another PR from the same locked backlog.
  const candidates = database.db
    .select({
      id: pullRequests.id,
      repositoryId: repositories.publicId,
      dueAt: pullRequests.mergeAfter,
      position:
        sql<number>`row_number() over (partition by ${pullRequests.repositoryId} order by ${pullRequests.mergeAfter}, ${pullRequests.id})`.as(
          "position",
        ),
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .where(
      and(
        lte(pullRequests.mergeAfter, new Date()),
        eq(repositories.status, "active"),
      ),
    )
    .as("due_prs");
  const due = await database.db
    .select()
    .from(candidates)
    .orderBy(candidates.position, candidates.dueAt, candidates.id)
    .limit(10);
  for (const item of due)
    await interactionLock(database, `repository:${item.repositoryId}`, () =>
      triagePullRequest(database, item.id),
    );
}
