import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  previousFindingsSchema,
  type PreviousFinding,
  type ReviewConversation,
  type ReviewFinding,
} from "@razbor/contracts";
import type {
  ForgeChange,
  ForgeType,
  ForgeWebhook,
  RepositoryMetadata,
} from "@razbor/forge-adapters";

import { snapshotRepositoryAgent } from "@database/src/agents.js";
import type { Database, Transaction } from "@database/src/connection.js";
import { publicId } from "@database/src/ids.js";
import { snapshotRepositoryMcpServers } from "@database/src/mcp.js";
import { latestMergeReview } from "@database/src/merge-policy.js";
import { findingKey } from "@database/src/presentation.js";
import { rearmStalePublication } from "@database/src/rearm-publication.js";
import {
  dispatchOutbox,
  pullRequests,
  repositories,
  repositoryWebhooks,
  reviews,
  reviewTriggers,
  webhookDeliveries,
} from "@database/src/schema.js";
import { snapshotRepositoryGuidance } from "@database/src/skills.js";

const supersededPublication = {
  state: "stale",
  stale: true,
  error:
    "Automatic review superseded by a newer revision, pull request state, or trigger policy.",
} as const;

type ChangeEvent = Exclude<ForgeWebhook, { kind: "ping" | "push" }>;

type ReviewRevision = Pick<
  ForgeChange,
  "number" | "headSha" | "baseSha" | "mergeBase" | "startSha"
>;

type Observation = {
  event: ChangeEvent;
  change?: ForgeChange;
  generation: number;
  unseenBoundaryCount?: number;
  previous?: PreviousFinding[];
  conversation?: ReviewConversation;
  commandAt?: string;
  /** Whether the verified PR author may trigger fully automatic reviews under this hook's settings. */
  automaticAuthorPermitted?: boolean;
  waitingForDiff?: boolean;
};

/**
 * Rebuild outstanding console findings from immutable PR-bound results. Each
 * result index identifies one occurrence even when two entries share a root
 * cause. Only an assessment of its admission snapshot can retire it.
 */
export async function previousConsoleFindings(
  db: Database["db"] | Transaction,
  repositoryId: string,
  number: number,
  excludeReviewId?: string,
) {
  const resolvedIds = sql`jsonb_path_query_array(${reviews.result},
    '$.findingChecks[*] ? (@.status == "resolved" && @.id starts with "console:").id')`;
  const history = await db
    .select({
      id: reviews.publicId,
      head: reviews.headSha,
      findings: sql<
        ReviewFinding[] | null
      >`case when ${reviewTriggers.id} is null then ${reviews.result}->'findings' end`,
      // A console assessment must be repeated when the destination or revision changes.
      resolved: sql<
        PreviousFinding[] | null
      >`case when ${reviewTriggers.id} is not null or (
        ${reviews.source}->>'mergeRevision' = ${pullRequests.mergeRevision}::text
        and ${reviews.headSha} = ${pullRequests.headSha} and ${reviews.baseSha} = ${pullRequests.baseSha}
      ) then jsonb_path_query_array(${reviews.source}, '$.previousFindings[*] ? (@.id == $ids[*])',
        jsonb_build_object('ids', ${resolvedIds})) end`,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.mergePullRequestId))
    .leftJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .leftJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
    .where(
      and(
        eq(reviews.repositoryId, repositoryId),
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, number),
        eq(reviews.status, "completed"),
        sql`${reviews.source}->>'conversation' is null`,
        excludeReviewId ? ne(reviews.publicId, excludeReviewId) : undefined,
        or(
          and(
            isNull(reviewTriggers.id),
            sql`jsonb_array_length(${reviews.result}->'findings') > 0`,
          ),
          and(
            sql`jsonb_array_length(${resolvedIds}) > 0`,
            or(
              isNull(reviewTriggers.id),
              sql`${dispatchOutbox.publication}->>'state' = 'published'
                  and ${dispatchOutbox.publication}->>'stale' is distinct from 'true'
                  and ${dispatchOutbox.publication}->>'rearmed' is distinct from 'true'`,
            ),
          ),
        ),
      ),
    )
    .orderBy(reviews.createdAt, reviews.publicId);
  const open = new Map<string, PreviousFinding>();
  for (const row of history) {
    for (const saved of row.resolved ?? []) {
      const old = open.get(saved.id);
      if (
        old &&
        saved.reviewId === old.reviewId &&
        findingKey(saved.finding) === findingKey(old.finding)
      )
        open.delete(saved.id);
    }
    for (const [index, finding] of (row.findings ?? []).entries()) {
      const id = `console:${row.id}:${index}`;
      open.set(id, { id, reviewId: row.id, originalHead: row.head, finding });
    }
  }
  return [...open.values()];
}

/** Fill the remaining admission budget with console findings. The merge audit still reads every occurrence. */
export function consoleFindingSnapshot(
  consoleFindings: PreviousFinding[],
  published: PreviousFinding[] = [],
) {
  const snapshot = previousFindingsSchema.parse(published);
  for (const finding of consoleFindings) {
    snapshot.push(finding);
    if (!previousFindingsSchema.safeParse(snapshot).success) {
      snapshot.pop();
      if (previousFindingsSchema.safeParse([finding]).success) break;
    }
  }
  return snapshot;
}

/** Match a redelivery or an already declined command replayed under a different delivery ID. */
export function triggerDelivery(hookId: string, event: ChangeEvent) {
  return and(
    eq(webhookDeliveries.webhookId, hookId),
    or(
      eq(webhookDeliveries.deliveryId, event.deliveryId),
      event.kind === "comment"
        ? eq(
            webhookDeliveries.closedCommandId,
            `${event.number}:${event.commentId}`,
          )
        : undefined,
    ),
  );
}

/** Match a provider change by its repository-scoped number, including records predating trigger modes. */
function sameChange(repositoryId: string, number?: number) {
  return and(
    eq(reviewTriggers.repositoryId, repositoryId),
    number === undefined
      ? undefined
      : sql`${reviewTriggers.change}->>'number' = ${String(number)}`,
  );
}

/** Public fully automatic reviews require an explicit case-insensitive match for the forge's PR author. */
export function allowsAutomaticAuthor(
  visibility: RepositoryMetadata["visibility"] | undefined,
  author: string | null | undefined,
  senders: string[],
) {
  if (visibility !== "public")
    return visibility === "private" || visibility === "internal";
  const login = author?.toLowerCase();
  return (
    !!login &&
    login !== "*" &&
    senders.some((sender) => sender.toLowerCase() === login)
  );
}

/** Retire queued automatic work atomically with its publication, leaving running attempts and historical results alone. */
export async function supersedeQueuedAutomaticReviews(
  tx: Transaction,
  repositoryId: string,
  number?: number,
  except?: string,
) {
  const changed = await tx
    .update(reviews)
    .set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(reviews.status, "queued"),
        except ? sql`${reviews.id} <> ${except}` : undefined,
        inArray(
          reviews.id,
          tx
            .select({ id: reviewTriggers.reviewId })
            .from(reviewTriggers)
            .where(
              and(
                sameChange(repositoryId, number),
                eq(reviewTriggers.origin, "automatic"),
              ),
            ),
        ),
      ),
    )
    .returning({ id: reviews.id });
  if (changed.length)
    await tx
      .update(dispatchOutbox)
      .set({
        publication: supersededPublication,
        interactionAfter: new Date(),
      })
      .where(
        inArray(
          dispatchOutbox.reviewId,
          changed.map((row) => row.id),
        ),
      );
}

/** Name the session lock held only while submitting a new policy-authorized native verdict. */
export function reviewSubmissionLock(repositoryId: string) {
  return `review-submission:${repositoryId}`;
}

/** Allow concurrent session writers, ordered before or after a native submission for this repository. */
export async function lockReviewTriggerChanges(
  tx: Transaction,
  repositoryId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(748322, hashtext(${reviewSubmissionLock(repositoryId)}))`,
  );
}

/** Reset opt-ins and retire waiting automatic jobs under the caller's owning repository lock when policy changes. */
export async function resetRepositoryReviewTriggers(
  tx: Transaction,
  repositoryId: string,
) {
  await lockReviewTriggerChanges(tx, repositoryId);
  // A later policy applies to new deliveries, including when the previous one has not obtained its diff yet.
  await tx
    .update(webhookDeliveries)
    .set({ pendingAction: null, pendingOpen: null, openRetryAfter: null })
    .where(
      and(
        sql`${webhookDeliveries.openRetryAfter} is not null`,
        inArray(
          webhookDeliveries.webhookId,
          tx
            .select({ id: repositoryWebhooks.id })
            .from(repositoryWebhooks)
            .where(eq(repositoryWebhooks.repositoryId, repositoryId)),
        ),
      ),
    );
  await tx
    .update(pullRequests)
    .set({
      continuousReviewSince: null,
      reviewSessionResetAt: new Date(),
      triggerGeneration: sql`${pullRequests.triggerGeneration}+1`,
    })
    .where(eq(pullRequests.repositoryId, repositoryId));
  await supersedeQueuedAutomaticReviews(tx, repositoryId);
}

/** Count durable close/reopen receipts, including events with equal or out-of-order provider timestamps. */
async function countUnseenBoundaries(
  db: Pick<Transaction, "select">,
  webhookId: string,
  number: number,
) {
  const [row] = await db
    .select({ total: count() })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, webhookId),
        eq(webhookDeliveries.boundaryNumber, number),
      ),
    );
  return row.total;
}

/** Snapshot the PR generation, or the boundary receipts for a GitLab MR without a PR row, before provider I/O. */
export async function reviewTriggerSession(
  database: Database,
  repositoryId: string,
  number: number,
  gitlabWebhookId: string | undefined,
) {
  const [session] = await database.db
    .select({
      generation: pullRequests.triggerGeneration,
      continuousReviewSince: pullRequests.continuousReviewSince,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, number),
      ),
    );
  return {
    continuousReviewSince: session?.continuousReviewSince,
    version: {
      generation: session?.generation ?? 0,
      unseenBoundaryCount:
        !session && gitlabWebhookId
          ? await countUnseenBoundaries(database.db, gitlabWebhookId, number)
          : undefined,
    },
  };
}

/**
 * Find the latest code review of the same PR and diff, including older source-only records.
 * Admission may retry a failed run. Refresh must respect a newer failed run as well.
 */
export async function latestRevisionReview(
  tx: Transaction,
  repositoryId: string,
  change: ReviewRevision,
  includeFailed: boolean,
) {
  const [latest] = await tx
    .select({
      id: reviews.id,
      status: reviews.status,
      origin: reviewTriggers.origin,
    })
    .from(reviews)
    .leftJoin(reviewTriggers, eq(reviews.id, reviewTriggers.reviewId))
    .where(
      and(
        eq(reviews.repositoryId, repositoryId),
        eq(reviews.headSha, change.headSha),
        eq(reviews.baseSha, change.mergeBase),
        or(
          and(
            sameChange(repositoryId, change.number),
            sql`${reviewTriggers.change}->>'baseSha' = ${change.baseSha}`,
            sql`${reviewTriggers.change}->>'startSha' is not distinct from ${change.startSha ?? null}`,
          ),
          and(
            isNull(reviewTriggers.reviewId),
            sql`${reviews.source}->'pullRequest'->>'number' = ${String(change.number)} and ${reviews.source}->'pullRequest'->>'baseSha' = ${change.baseSha}`,
          ),
        ),
        sql`${reviews.source}->>'conversation' is null`,
        includeFailed
          ? undefined
          : inArray(reviews.status, ["queued", "running", "completed"]),
      ),
    )
    .orderBy(desc(reviews.createdAt), desc(reviews.publicId))
    .limit(1);
  return latest;
}

/** Reoffer the latest completed automatic result after refresh verifies its revision and policy eligibility. */
export async function rearmRefreshedPublication(
  tx: Transaction,
  repositoryId: string,
  change: ReviewRevision,
  generation: number,
) {
  const latest = await latestRevisionReview(tx, repositoryId, change, true);
  if (latest?.status === "completed" && latest.origin === "automatic")
    await rearmStalePublication(tx, latest.id, generation);
}

/** Snapshot a verified provider change and route both origins through the same immutable attempt and publication pipeline. */
async function queueReview(
  tx: Transaction,
  repo: typeof repositories.$inferSelect,
  hookId: string,
  forge: ForgeType,
  change: ForgeChange,
  observation: Observation,
  target: typeof pullRequests.$inferSelect,
  generation: number,
) {
  const { event, previous, conversation } = observation;
  const automatic = event.kind !== "comment";
  // This transaction holds the repository's webhook row lock. The review row lock also
  // fences runner reservation: only an unstarted review may receive a new revision.
  let queued: typeof reviews.$inferSelect | undefined;
  if (automatic) {
    const [entry] = await latestMergeReview(tx, target.id);
    const latest = entry?.review;
    const sameDiff =
      latest &&
      latest.headSha === change.headSha &&
      latest.baseSha === change.mergeBase &&
      (entry.trigger?.baseSha ?? latest.source.pullRequest?.baseSha) ===
        change.baseSha &&
      (!entry.trigger ||
        (entry.trigger.startSha ?? null) === (change.startSha ?? null));
    // A refresh may already have observed the ready transition. A title edit
    // needs work only when an existing review is stale under merge automation.
    if (
      forge === "forgejo" &&
      event.kind === "ready" &&
      generation === observation.generation &&
      (!repo.mergePolicy.enabled ||
        !sameDiff ||
        latest.source.mergeRevision === undefined ||
        latest.source.mergeRevision === target.mergeRevision)
    )
      return;
    if (
      sameDiff &&
      !latest.source.conversation &&
      (latest.source.mergePolicy?.version ?? 1) === repo.mergePolicyVersion &&
      (!repo.mergePolicy.enabled ||
        latest.source.mergeRevision === target.mergeRevision) &&
      ["queued", "running", "completed"].includes(latest.status)
    ) {
      await supersedeQueuedAutomaticReviews(
        tx,
        repo.id,
        change.number,
        latest.id,
      );
      if (latest.status === "completed" && entry.trigger)
        await rearmStalePublication(tx, latest.id, generation);
      return undefined;
    }
    // A restored revision can replay its saved stale result without inference
    // when merge automation is disabled. A newer attempt on this same diff
    // always takes precedence, including a failed manual re-review.
    if (latest && !sameDiff && !repo.mergePolicy.enabled) {
      const candidate = await latestRevisionReview(tx, repo.id, change, true);
      const [replay] =
        candidate?.status === "completed" && candidate.origin
          ? await tx
              .select({ id: reviews.id })
              .from(reviews)
              .innerJoin(
                dispatchOutbox,
                eq(dispatchOutbox.reviewId, reviews.id),
              )
              .where(
                and(
                  eq(reviews.id, candidate.id),
                  eq(reviews.mergePullRequestId, target.id),
                  sql`coalesce((${reviews.source}->'mergePolicy'->>'version')::int,1) = ${repo.mergePolicyVersion}`,
                  sql`(${dispatchOutbox.publication}->>'state' = 'stale' or ${dispatchOutbox.publication}->>'rearmed' = 'true')`,
                ),
              )
          : [];
      if (replay) {
        await supersedeQueuedAutomaticReviews(tx, repo.id, change.number);
        await rearmStalePublication(tx, replay.id, generation);
        return undefined;
      }
    }
    const [pending] = latest
      ? await tx
          .select({ review: reviews })
          .from(reviews)
          .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
          .where(
            and(
              sameChange(repo.id, change.number),
              eq(reviewTriggers.origin, "automatic"),
              eq(reviews.status, "queued"),
              eq(reviews.version, 0),
              eq(reviews.id, latest.id),
            ),
          )
          .limit(1)
          .for("update", { of: reviews })
      : [];
    queued = pending?.review;
    // Retire a previous revision already waiting for a retry even when its old
    // model assignment can no longer get a runner. A live attempt stays pinned.
    await supersedeQueuedAutomaticReviews(
      tx,
      repo.id,
      change.number,
      queued?.id,
    );
  }
  // Admission only queues work. The review insert/update wakes triage, which
  // reconciles any older provider authority before this review can authorize a write.
  const git = structuredClone(repo.git);
  const remote = git.upstream.split("/")[2];
  const ref =
    forge === "gitlab"
      ? `refs/merge-requests/${change.number}/head`
      : `refs/pull/${change.number}/head`;
  git.extra_fetch_refs[remote] = [
    ...new Set([...(git.extra_fetch_refs[remote] ?? []), ref]),
  ];
  const agent = await snapshotRepositoryAgent(tx, repo.agentId, repo.contextId);
  const guidance = await snapshotRepositoryGuidance(
    tx,
    repo.guidance,
    repo.contextId,
  );
  const mcpServers = await snapshotRepositoryMcpServers(tx, repo.id);
  const values = {
    repositoryId: repo.id,
    mergePullRequestId: conversation ? null : target.id,
    baseSha: change.mergeBase,
    headSha: change.headSha,
    source: {
      configKey: repo.configKey,
      git,
      indexOwner: repo.indexOwner,
      ...(!conversation
        ? {
            mergePolicy: {
              version: repo.mergePolicyVersion,
              policy: repo.mergePolicy,
            },
            mergeRevision: target.mergeRevision,
            baseBranch: target.baseBranch ?? undefined,
            headBranch: target.headBranch ?? undefined,
            pullRequest: {
              number: change.number,
              title: change.title,
              url: change.url,
              baseSha: change.baseSha,
            },
          }
        : {}),
      ...(agent ? { agent } : {}),
      ...(guidance ? { guidance } : {}),
      ...(mcpServers.length ? { mcpServers } : {}),
      previousFindings: previous,
      conversation,
    },
  };
  if (queued) {
    await tx
      .update(reviews)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(reviews.id, queued.id));
    await tx
      .update(reviewTriggers)
      .set({ change })
      .where(eq(reviewTriggers.reviewId, queued.id));
    await tx
      .update(dispatchOutbox)
      .set({ interactionAfter: new Date() })
      .where(eq(dispatchOutbox.reviewId, queued.id));
    return queued.publicId;
  }
  const [review] = await tx
    .insert(reviews)
    .values({ ...values, publicId: publicId("review") })
    .returning();
  await tx.insert(reviewTriggers).values({
    webhookId: hookId,
    repositoryId: repo.id,
    reviewId: review.id,
    origin: automatic ? "automatic" : "manual",
    commentId: event.kind === "comment" ? event.commentId : null,
    change,
  });
  await tx.insert(dispatchOutbox).values({
    reviewId: review.id,
    publication: { state: "pending" },
    acknowledgedAt: automatic ? new Date() : null,
  });
  return review.publicId;
}

/**
 * Fence observations against policy, webhook and PR changes, then atomically save the delivery,
 * activation/reset, review and outbox. A racing observation must refetch before recording its delivery.
 */
export async function acceptReviewTrigger(
  database: Database,
  repo: typeof repositories.$inferSelect,
  hook: typeof repositoryWebhooks.$inferSelect,
  forge: ForgeType,
  observation: Observation,
) {
  const { event, change } = observation;
  return database.transaction(async (tx) => {
    const [active] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo.id))
      .for("share");
    if (
      !active ||
      active.status !== "active" ||
      !active.verifiedAt ||
      active.version !== repo.version ||
      active.externalRepositoryId !== event.repositoryId ||
      active.reviewTriggerMode !== repo.reviewTriggerMode
    )
      throw new Error("Repository policy changed");
    await lockReviewTriggerChanges(tx, repo.id);
    const [current] = await tx
      .select()
      .from(repositoryWebhooks)
      .where(eq(repositoryWebhooks.id, hook.id))
      .for("update");
    if (
      !current?.enabled ||
      current.updatedAt.getTime() !== hook.updatedAt.getTime()
    )
      throw new Error("Webhook policy changed");
    const scope = and(
      eq(pullRequests.repositoryId, repo.id),
      eq(pullRequests.number, event.number),
    );
    const [session] = await tx
      .select()
      .from(pullRequests)
      .where(scope)
      .for("update");
    if (
      (session?.triggerGeneration ?? 0) !== observation.generation ||
      (observation.unseenBoundaryCount !== undefined &&
        (session ||
          (await countUnseenBoundaries(tx, hook.id, event.number)) !==
            observation.unseenBoundaryCount))
    )
      return { retry: true } as const;
    // A deferred worker can retire this receipt without taking the webhook lock.
    let [receipt] = await tx
      .select()
      .from(webhookDeliveries)
      .where(triggerDelivery(hook.id, event))
      .for("update");
    if (
      receipt?.pendingOpen &&
      (event.kind !== receipt.pendingOpen.kind ||
        receipt.pendingOpen.number !== event.number ||
        receipt.pendingOpen.repositoryId !== event.repositoryId ||
        receipt.pendingOpen.hookUpdatedAt !== hook.updatedAt.toISOString())
    )
      return { duplicate: true } as const;
    if (
      receipt &&
      !receipt.pendingOpen &&
      receipt.pendingAction !== "review-history"
    ) {
      if (
        receipt.pendingAction &&
        event.kind === "comment" &&
        receipt.closedCommandId === `${event.number}:${event.commentId}`
      )
        return { closedReplyId: receipt.id } as const;
      return { duplicate: true } as const;
    }
    if (!receipt) {
      [receipt] = await tx
        .insert(webhookDeliveries)
        .values({ webhookId: hook.id, deliveryId: event.deliveryId })
        .onConflictDoNothing()
        .returning();
      if (!receipt) return { duplicate: true } as const;
    }
    if (observation.waitingForDiff && receipt.pendingOpen)
      return { waitingForDiff: true } as const;
    await tx
      .update(repositoryWebhooks)
      .set({ lastDelivery: "accepted", lastDeliveryAt: new Date() })
      .where(eq(repositoryWebhooks.id, hook.id));
    let since = session?.continuousReviewSince ?? null;
    let reset = session?.reviewSessionResetAt ?? null;
    const closed = !change && !observation.waitingForDiff;
    const boundaryEvent = event.kind === "closed" || event.kind === "reopened";
    if (closed || boundaryEvent) {
      // A delayed boundary cannot revoke an opt-in posted in a later open session.
      const boundary =
        event.kind !== "comment" && event.occurredAt
          ? new Date(event.occurredAt)
          : receipt.createdAt;
      if (!reset || reset < boundary) reset = boundary;
      if (closed || (since && since <= reset)) since = null;
      if (forge === "gitlab" && closed && !session) {
        // No PR row exists yet to retain this verified closure.
        await tx
          .update(webhookDeliveries)
          .set({ boundaryNumber: event.number, boundaryAt: boundary })
          .where(eq(webhookDeliveries.id, receipt.id));
      }
    }
    if (observation.waitingForDiff && event.kind !== "comment") {
      // GitLab verified the MR is open but has no current diff. Invalidate the
      // old revision's readiness and apply session boundaries before retrying.
      if (session) {
        const changed =
          session.state !== "open" ||
          session.draft !== null ||
          since?.getTime() !== session.continuousReviewSince?.getTime() ||
          reset?.getTime() !== session.reviewSessionResetAt?.getTime();
        const now = new Date();
        await tx
          .update(pullRequests)
          .set({
            state: "open",
            draft: null,
            continuousReviewSince: since,
            reviewSessionResetAt: reset,
            triggerGeneration: observation.generation + (changed ? 1 : 0),
            updatedAt: now,
            syncedAt: now,
          })
          .where(scope);
        if (
          boundaryEvent &&
          active.reviewTriggerMode === "opt_in_continuous" &&
          !since
        )
          await supersedeQueuedAutomaticReviews(tx, repo.id, event.number);
      }
      await tx
        .update(webhookDeliveries)
        .set({
          pendingOpen: {
            ...event,
            hookUpdatedAt: hook.updatedAt.toISOString(),
          },
          openRetryAfter: new Date(),
        })
        .where(eq(webhookDeliveries.id, receipt.id));
      return { waitingForDiff: true } as const;
    }
    if (receipt.pendingAction || receipt.pendingOpen) {
      await tx
        .update(webhookDeliveries)
        .set({ pendingAction: null, pendingOpen: null, openRetryAfter: null })
        .where(eq(webhookDeliveries.id, receipt.id));
    }
    if (event.kind === "comment") {
      const [prior] = await tx
        .select({ id: reviews.publicId })
        .from(reviewTriggers)
        .innerJoin(reviews, eq(reviews.id, reviewTriggers.reviewId))
        .where(
          and(
            eq(reviewTriggers.repositoryId, repo.id),
            eq(reviewTriggers.commentId, event.commentId),
          ),
        );
      if (prior) return { duplicate: true } as const;
    }
    const activating =
      change &&
      event.kind === "comment" &&
      !observation.conversation &&
      active.reviewTriggerMode === "opt_in_continuous";
    if (activating && forge === "gitlab") {
      // A verified close/reopen can precede the first PR snapshot. Its time
      // belongs to the MR even if a settings edit revoked the delivery retry.
      const [latest] = await tx
        .select({ boundary: webhookDeliveries.boundaryAt })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.webhookId, hook.id),
            eq(webhookDeliveries.boundaryNumber, event.number),
          ),
        )
        .orderBy(desc(webhookDeliveries.boundaryAt))
        .limit(1);
      if (latest?.boundary) {
        if (!reset || reset < latest.boundary) reset = latest.boundary;
        if (since && since <= reset) since = null;
      }
    }
    if (activating) {
      const posted = observation.commandAt
        ? new Date(observation.commandAt)
        : undefined;
      if (!reset || (posted && posted > reset)) {
        const activated = posted ?? new Date();
        if (!since || activated > since) since = activated;
      }
    }
    const now = new Date();
    const headBranch = change?.headBranch ?? session?.headBranch ?? null;
    const baseBranch = change?.baseBranch ?? session?.baseBranch ?? null;
    // Equal-head deliveries can share an observation generation. Only changes
    // affecting eligibility or the diff invalidate another request's provider read.
    const changed =
      !session ||
      session.state !== (change ? "open" : "closed") ||
      (change &&
        (session.headSha !== change.headSha ||
          session.baseSha !== change.baseSha ||
          session.mergeBase !== change.mergeBase ||
          session.startSha !== (change.startSha ?? null) ||
          session.headBranch !== headBranch ||
          session.baseBranch !== baseBranch ||
          session.draft !== (change.draft ?? null))) ||
      session.continuousReviewSince?.getTime() !== since?.getTime() ||
      session.reviewSessionResetAt?.getTime() !== reset?.getTime();
    const sessionValues = {
      continuousReviewSince: since,
      reviewSessionResetAt: reset,
      triggerGeneration: observation.generation + (changed ? 1 : 0),
      syncedAt: now,
      updatedAt: now,
    };
    let target = session;
    if (change) {
      const values = {
        ...sessionValues,
        number: event.number,
        draft: change.draft ?? null,
        mergeBase: change.mergeBase,
        startSha: change.startSha ?? null,
        title: change.title,
        url: change.url,
        state: "open" as const,
        author: change.author ?? null,
        headSha: change.headSha,
        baseSha: change.baseSha,
        headBranch,
        baseBranch,
      };
      [target] = await tx
        .insert(pullRequests)
        .values({
          ...values,
          publicId: publicId("pullRequest"),
          repositoryId: repo.id,
        })
        .onConflictDoUpdate({
          target: [pullRequests.repositoryId, pullRequests.number],
          set: values,
        })
        .returning();
    } else if (session) {
      await tx
        .update(pullRequests)
        .set({ ...sessionValues, state: "closed" })
        .where(scope);
    }
    const automaticAllowed =
      (active.reviewTriggerMode === "automatic" &&
        observation.automaticAuthorPermitted === true) ||
      (active.reviewTriggerMode === "opt_in_continuous" && since !== null);
    if (
      !change ||
      (event.kind !== "comment" &&
        (!automaticAllowed || change.draft !== false))
    ) {
      await supersedeQueuedAutomaticReviews(tx, repo.id, event.number);
      if (!change && event.kind === "comment") {
        await tx
          .update(webhookDeliveries)
          .set({
            closedCommandId: `${event.number}:${event.commentId}`,
            pendingAction: "closed-reply",
          })
          .where(eq(webhookDeliveries.id, receipt.id));
        return { closedReplyId: receipt.id } as const;
      }
      return {} as const;
    }
    if (
      (event.kind === "closed" || event.kind === "reopened") &&
      !observation.previous
    ) {
      // Commit the reset before optional remote history reads. A failed read
      // leaves the delivery resumable at the same boundary on redelivery.
      await tx
        .update(webhookDeliveries)
        .set({
          pendingAction: "review-history",
          pendingOpen: receipt.pendingOpen,
          openRetryAfter: receipt.openRetryAfter,
        })
        .where(eq(webhookDeliveries.id, receipt.id));
      return { historyGeneration: sessionValues.triggerGeneration } as const;
    }
    if (!target) throw new Error("Missing persisted pull request for review");
    const reviewId = await queueReview(
      tx,
      active,
      hook.id,
      forge,
      change,
      observation,
      target,
      sessionValues.triggerGeneration,
    );
    return { reviewId } as const;
  });
}

/**
 * Hold a newer automatic revision until an older automatic attempt (including its retries) reaches a terminal state.
 * The runner rechecks this condition after locking its review; a claimed queue message carries only the stable job identity.
 */
export function automaticReviewReady() {
  return sql`not exists (
    select 1 from review_triggers candidate
    join review_triggers other on other.repository_id = candidate.repository_id
      and other.change->>'number' = candidate.change->>'number' and other.origin = 'automatic'
    join reviews busy on busy.id = other.review_id and busy.id <> candidate.review_id
    where candidate.review_id = ${reviews.id} and candidate.origin = 'automatic'
      and busy.version > 0 and busy.status in ('queued','running')
  )`;
}

/** Finish a discarded automatic retry without consuming another attempt. The caller holds the review row. */
export async function retireObsoleteAutomaticRetry(
  tx: Transaction,
  review: typeof reviews.$inferSelect,
) {
  const [obsolete] = await tx
    .select({ id: reviewTriggers.id })
    .from(reviewTriggers)
    .innerJoin(repositories, eq(repositories.id, reviewTriggers.repositoryId))
    .innerJoin(
      pullRequests,
      and(
        eq(pullRequests.repositoryId, repositories.id),
        sql`${pullRequests.number}::text = ${reviewTriggers.change}->>'number'`,
      ),
    )
    .where(
      and(
        eq(reviewTriggers.reviewId, review.id),
        eq(reviewTriggers.origin, "automatic"),
        sql`(${pullRequests.state} <> 'open' or ${pullRequests.draft} is distinct from false
        or ${pullRequests.headSha} <> ${review.headSha}
        or ${pullRequests.baseSha} <> ${reviewTriggers.change}->>'baseSha'
        or ${pullRequests.mergeBase} is distinct from ${review.baseSha}
        or ${pullRequests.startSha} is distinct from ${reviewTriggers.change}->>'startSha'
        or ${repositories.reviewTriggerMode} = 'manual'
        or (${repositories.reviewTriggerMode} = 'opt_in_continuous' and ${pullRequests.continuousReviewSince} is null))`,
      ),
    );
  if (!obsolete) return false;
  const now = new Date();
  await tx
    .update(reviews)
    .set({ status: "failed", finishedAt: now, updatedAt: now })
    .where(eq(reviews.id, review.id));
  await tx
    .update(dispatchOutbox)
    .set({ publication: supersededPublication, interactionAfter: now })
    .where(eq(dispatchOutbox.reviewId, review.id));
  return true;
}
