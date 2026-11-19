import { and, eq } from "drizzle-orm";

import {
  MAX_ESCALATION_MENTIONS,
  renderMergeEscalation,
  type MergeDecision,
  type ReviewApprovalStatus,
} from "@razbor/contracts";
import { ForgeOperationError } from "@razbor/forge-adapters";

import type { Database } from "@database/src/connection.js";
import { withCurrentMergeReview } from "@database/src/merge-policy.js";
import {
  pullRequests,
  type repositories,
  type reviews,
  type EscalationComment,
} from "@database/src/schema.js";
import type { triageForge } from "@database/src/webhooks.js";

type Review = typeof reviews.$inferSelect;

type PullRequest = typeof pullRequests.$inferSelect;

type Repo = typeof repositories.$inferSelect;

type ProviderClient = Awaited<ReturnType<typeof triageForge>>;

const reservationWaitMs = 120_000;

/** Reconcile an already-fenced owned comment before creating or editing the single persistent escalation. */
export async function syncEscalation(
  database: Database,
  repo: Repo,
  pr: PullRequest,
  review: Review,
  decision: MergeDecision,
  client: ProviderClient,
  reportDryRun = false,
  approval?: ReviewApprovalStatus,
) {
  const snapshot = review.source.mergePolicy;
  if (!snapshot) return;
  const { api, bot } = client;
  let saved: EscalationComment = pr.escalationComment ?? { botId: bot.id };
  if (saved.botId !== bot.id) throw new ForgeOperationError("permission");
  const marker = `<!-- razbor:${pr.publicId}:escalation -->`;
  const pendingMarker = `<!-- razbor:${pr.publicId}:escalation-pending -->`;
  const reservation = `Preparing the Razbor review decision.\n\n${pendingMarker}`;
  const human =
    decision.status === "human_review_required" &&
    snapshot.version === repo.mergePolicyVersion &&
    snapshot.policy.enabled &&
    pr.state === "open";
  const publish = human || reportDryRun;

  /** Commit the chosen provider ID or mention intent before an external write can survive a restart. */
  async function save(value: EscalationComment) {
    return withCurrentMergeReview(database, repo, pr, review, async (tx) => {
      await tx
        .update(pullRequests)
        .set({ escalationComment: value })
        .where(eq(pullRequests.id, pr.id));
      return true;
    });
  }

  // A create request can arrive after an empty listing. Only POST inert reservations;
  // a single committed ID can ever receive the decision and its notification by edit.
  const notes = pr.escalationComment
    ? await api.comments(pr.number, { complete: true })
    : [];
  const owned = notes.filter((note) => note.user.id === bot.id);
  const published = owned.filter((note) => note.body.endsWith("\n" + marker));
  const pending = owned.filter((note) =>
    note.body.endsWith("\n" + pendingMarker),
  );
  if (
    pending.some((note) => note.body !== reservation) ||
    (!saved.creatingBody && published.length > 1)
  )
    throw new ForgeOperationError("permission");

  // Earlier versions POSTed the actual notification. Only an exact, unique readback
  // can recover one of those writes without risking a duplicate mention.
  if (saved.creatingBody) {
    if (published.length !== 1 || published[0].body !== saved.creatingBody) {
      if (!saved.reservationRetryAt) {
        await save({
          ...saved,
          reservationRetryAt: Date.now() + reservationWaitMs,
        });
      } else if (saved.reservationRetryAt <= Date.now()) {
        // The console now displays the operator recovery instructions. A slow
        // presence check can still adopt the original if the provider delivers it.
        return;
      }
      throw new ForgeOperationError("unavailable", true);
    }
    saved = {
      botId: bot.id,
      remoteId: published[0].id,
      shownBody: published[0].body,
      mentioned: saved.mentioned,
    };
    if (!(await save(saved))) return;
  }
  const final = published[0];
  if (final && final.id !== saved.remoteId)
    throw new ForgeOperationError("permission");

  let current = notes.find((note) => note.id === saved.remoteId);
  if (
    current &&
    (current.user.id !== bot.id ||
      (current.body !== reservation && current.id !== final?.id))
  )
    throw new ForgeOperationError("permission");
  if (saved.remoteId && !current) {
    // A hidden comment, lost permissions or a stale paginated list cannot authorize a
    // replacement. Require both the bound ID lookup and a complete list to agree.
    try {
      await api.comment(saved.remoteId, pr.number);
      throw new ForgeOperationError("unavailable", true);
    } catch (error) {
      if (!(error instanceof ForgeOperationError && error.status === 404))
        throw error;
    }
    saved = {
      botId: bot.id,
      mentioned: saved.mentioned,
      pendingReservations: saved.pendingReservations,
    };
    if (!(await save(saved))) return;
  }
  if (!current && publish) current = pending[0];
  if (current && current.id !== saved.remoteId) {
    saved = {
      ...saved,
      remoteId: current.id,
      reservationRetryAt: undefined,
      pendingReservations: Math.max(0, (saved.pendingReservations ?? 1) - 1),
    };
    if (!(await save(saved))) return;
  }
  for (const unused of pending) {
    if (unused.id === current?.id) continue;
    await api.deleteStatusComment(pr.number, unused.id, bot.id, pendingMarker);
    if (saved.pendingReservations) {
      saved = { ...saved, pendingReservations: saved.pendingReservations - 1 };
      if (!(await save(saved))) return;
    }
  }
  if (!current) {
    if (!publish) return;
    if (saved.reservationRetryAt && saved.reservationRetryAt > Date.now())
      throw new ForgeOperationError("unavailable", true);
    const previousPending = saved.pendingReservations ?? 0;
    saved = {
      ...saved,
      reservationRetryAt: Date.now() + reservationWaitMs,
      pendingReservations: previousPending + 1,
    };
    if (!(await save(saved))) return;
    let id: string;
    try {
      id = await api.postComment(pr.number, reservation);
    } catch (error) {
      if (error instanceof ForgeOperationError && !error.uncertain)
        await save({ ...saved, pendingReservations: previousPending });
      throw error;
    }
    saved = {
      ...saved,
      remoteId: id,
      reservationRetryAt: undefined,
      pendingReservations: previousPending,
    };
    if (!(await save(saved))) return;
    current = { id, body: reservation, user: bot };
  }
  const reviewers: string[] = [];
  if (human) {
    const allowed = new Set(
      snapshot.policy.humanReviewers.map((candidate) => candidate.username),
    );
    for (const name of new Set(decision.reviewers)) {
      if (!allowed.has(name)) continue;
      // Consult only configured individual identities; a missing account cannot become an @mention.
      const login = await api.reviewerLogin(name);
      if (login?.toLowerCase() === name.toLowerCase()) reviewers.push(name);
      if (reviewers.length === MAX_ESCALATION_MENTIONS) break;
    }
    if (!reviewers.length && decision.reviewers.length) {
      const general = snapshot.policy.humanReviewers.filter(
        (candidate) =>
          !candidate.pathPatterns?.length && !candidate.riskCategories?.length,
      );
      const fallback = general.length
        ? general
        : snapshot.policy.humanReviewers.slice(0, 1);
      for (const candidate of fallback) {
        if (decision.reviewers.includes(candidate.username)) continue;
        const login = await api.reviewerLogin(candidate.username);
        if (login?.toLowerCase() === candidate.username.toLowerCase()) {
          reviewers.push(candidate.username);
          break;
        }
      }
    }
  }
  const options = {
    snapshot,
    headSha: review.headSha,
    marker,
    decision: { ...decision, reviewers },
    assessment: publish ? review.result?.mergeAssessment : undefined,
    approval,
  };
  const withMentions = renderMergeEscalation(options);
  const mention = human && !saved.mentioned && reviewers.length > 0;
  const body = renderMergeEscalation({ ...options, mention });
  if (current.body === body || current.body === withMentions) {
    if (saved.shownBody !== current.body)
      await save({
        ...saved,
        shownBody: current.body,
        mentioned:
          saved.mentioned ||
          (reviewers.length > 0 && current.body === withMentions),
      });
    return;
  }
  // Commit the write intent first. An ambiguous edit may arrive after a
  // confirmed correction, including after this PR closes.
  const intent: EscalationComment = {
    ...saved,
    mentioned: saved.mentioned || mention,
    uncertainEdit: true,
  };
  if (!(await save(intent))) return;
  const id = current.id;
  const expectedMarker = current.body === reservation ? pendingMarker : marker;
  const outcome = await withCurrentMergeReview(
    database,
    repo,
    pr,
    review,
    async (tx) => {
      try {
        await api.editStatusComment(
          pr.number,
          id,
          bot.id,
          expectedMarker,
          body,
        );
      } catch (error) {
        if (!(error instanceof ForgeOperationError) || error.uncertain)
          throw error;
        // A definitive refusal cannot have delivered this notification. Commit
        // the previous state before propagating the failure to the dispatcher.
        await tx
          .update(pullRequests)
          .set({ escalationComment: saved })
          .where(eq(pullRequests.id, pr.id));
        return error;
      }
      await tx
        .update(pullRequests)
        .set({
          escalationComment: {
            ...saved,
            shownBody: body,
            mentioned: intent.mentioned,
          },
        })
        .where(eq(pullRequests.id, pr.id));
      return true;
    },
  );
  if (outcome instanceof ForgeOperationError) throw outcome;
  if (!outcome) {
    // A replacement won the review lock before the provider call. Restore
    // only our unsent intent, preserving any newer reconciliation.
    await database.db
      .update(pullRequests)
      .set({ escalationComment: saved })
      .where(
        and(
          eq(pullRequests.id, pr.id),
          eq(pullRequests.escalationComment, intent),
        ),
      );
  }
}
