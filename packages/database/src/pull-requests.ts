import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";

import {
  publicIdSchema,
  type MergeDecision,
  type MergeAssessment,
  type ReviewJobView,
} from "@razbor/contracts";
import {
  createForge,
  ForgeOperationError,
  verifyRepository,
  type Forge,
  type ForgeChange,
  type ForgePullRequest,
} from "@razbor/forge-adapters";

import type { Database, Transaction } from "@database/src/connection.js";
import { getRepositoryGithubApp } from "@database/src/github-apps.js";
import { publicId } from "@database/src/ids.js";
import { readSecret } from "@database/src/registry.js";
import {
  allowsAutomaticAuthor,
  latestRevisionReview,
  lockReviewTriggerChanges,
  rearmRefreshedPublication,
  supersedeQueuedAutomaticReviews,
} from "@database/src/review-triggers.js";
import { reviewView, reviewViewSelection } from "@database/src/review-view.js";
import {
  forgeInstances,
  pullRequests,
  repositories,
  repositoryWebhooks,
  reviews,
  reviewTriggers,
} from "@database/src/schema.js";
import { interactionLock } from "@database/src/webhooks.js";

export type PullRequestReviewView = ReviewJobView & { targetBaseSha?: string };

export type PullRequestView = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  author?: string;
  headSha: string;
  baseSha: string;
  headBranch?: string;
  baseBranch?: string;
  updatedAt: string;
  createdAt: string;
  syncedAt: string;
  /** Current PR triage. Historical scores are available only on their review runs. */
  merge?: {
    decision: MergeDecision;
    action?: ReviewJobView["mergeAction"];
    confidence?: number;
    riskLevel?: MergeAssessment["riskLevel"];
    minimumConfidence?: number;
  };
  latestReview?: PullRequestReviewView;
  reviewCount: number;
  continuousReviewActive: boolean;
};

export type PullRequestDetail = PullRequestView & {
  reviews: PullRequestReviewView[];
};

const pullRequestReviewSelection = {
  ...reviewViewSelection,
  targetBaseSha: sql<
    string | null
  >`coalesce(${reviewTriggers.change}->>'baseSha', ${reviews.source}->'pullRequest'->>'baseSha')`,
};

/** Keep a code review's captured provider target distinct from its merge-base diff revision. */
function pullRequestReviewView(
  row: Parameters<typeof reviewView>[0] & { targetBaseSha: string | null },
): PullRequestReviewView {
  return {
    ...reviewView(row),
    ...(row.targetBaseSha ? { targetBaseSha: row.targetBaseSha } : {}),
  };
}

const latestReviewId = sql<string>`(
  select matched_review.id
  from reviews matched_review
  where matched_review.merge_pull_request_id = ${pullRequests.id}
    and matched_review.repository_id = ${pullRequests.repositoryId}
    and matched_review.result->>'mode' is distinct from 'conversation'
  order by matched_review.created_at desc, matched_review.public_id desc
  limit 1
)`;

const reviewCount = sql<number>`(
  select count(*)::integer
  from reviews matched_review
  where matched_review.merge_pull_request_id = ${pullRequests.id}
    and matched_review.repository_id = ${pullRequests.repositoryId}
    and matched_review.result->>'mode' is distinct from 'conversation'
)`;

/** Read accessible saved PRs with only their latest code review and full run count. */
async function pullRequestRows(
  database: Database,
  repositoryIds?: string[],
  id?: string,
) {
  repositoryIds?.forEach((repositoryId) =>
    publicIdSchema("repository").parse(repositoryId),
  );
  if (repositoryIds?.length === 0) return [];
  return database.db
    .select({
      pullRequest: pullRequests,
      repositoryId: repositories.publicId,
      policyVersion: repositories.mergePolicyVersion,
      reviewedBaseBranch: sql<
        string | null
      >`coalesce(${reviewTriggers.change}->>'baseBranch', ${reviews.source}->>'baseBranch')`,
      reviewedHeadBranch: sql<
        string | null
      >`coalesce(${reviewTriggers.change}->>'headBranch', ${reviews.source}->>'headBranch')`,
      reviewedDraft: sql<
        boolean | null
      >`(${reviewTriggers.change}->>'draft')::boolean`,
      reviewedRevision: sql<
        number | null
      >`(${reviews.source}->>'mergeRevision')::integer`,
      repositoryName: sql<string>`coalesce(${repositories.observed}->>'fullPath', ${repositories.selector}, ${repositories.configKey})`,
      olderUnresolvedAction: sql<"writing" | "scheduled" | "uncertain" | null>`(
        select prior.merge_action from reviews prior
        where prior.merge_pull_request_id = ${pullRequests.id}
          and prior.repository_id = ${pullRequests.repositoryId}
          and prior.id <> ${reviews.id}
          and prior.merge_action in ('writing', 'scheduled', 'uncertain')
        order by prior.created_at desc, prior.public_id desc limit 1
      )`,
      latestReview: pullRequestReviewSelection,
      reviewCount,
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .leftJoin(reviews, eq(reviews.id, latestReviewId))
    .leftJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .where(
      and(
        eq(repositories.status, "active"),
        id ? eq(pullRequests.publicId, id) : undefined,
        repositoryIds !== undefined
          ? inArray(repositories.publicId, repositoryIds)
          : undefined,
      ),
    )
    .orderBy(desc(pullRequests.updatedAt), pullRequests.publicId);
}

/** Project a current decision from the latest review, suppressing obsolete scores even when human ownership persists. */
function currentMergeView(
  row: Awaited<ReturnType<typeof pullRequestRows>>[number],
  review?: PullRequestReviewView,
): PullRequestView["merge"] {
  const pr = row.pullRequest;
  const decision = review?.mergeDecision;
  const stale =
    review?.mergePolicyVersion !== undefined &&
    (review.mergePolicyVersion !== row.policyVersion ||
      row.reviewedRevision !== pr.mergeRevision ||
      review.headSha !== pr.headSha ||
      review.targetBaseSha !== pr.baseSha ||
      row.reviewedBaseBranch !== pr.baseBranch ||
      row.reviewedHeadBranch !== pr.headBranch ||
      (row.reviewedDraft !== null && row.reviewedDraft !== pr.draft) ||
      (pr.state === "closed" && decision?.status !== "merged"));

  // A change in review authority cannot cancel an already-issued provider request.
  const action = review?.mergeAction;
  // A confirmed schedule with a current guard failure records the guard first
  // and its ownership separately. A prior fence alone cannot establish either.
  const confirmedSchedule =
    action === "scheduled" &&
    decision?.reasons
      .slice(1)
      .some(({ code }) => code === "provider_scheduled");
  const terminalProgress =
    decision?.status === "review_in_progress" &&
    review?.status !== "queued" &&
    review?.status !== "running";
  const unresolved =
    row.olderUnresolvedAction ??
    ((stale ||
      terminalProgress ||
      !decision ||
      decision.status === "stale" ||
      (decision.status === "blocked" && !confirmedSchedule) ||
      pr.humanEscalated) &&
    (action === "writing" || action === "scheduled" || action === "uncertain")
      ? action
      : null);
  const human = pr.state === "open" && pr.humanEscalated;
  if (
    unresolved ||
    (human && (stale || decision?.status !== "human_review_required"))
  ) {
    const reasons: MergeDecision["reasons"] = [];
    if (unresolved) {
      reasons.push({
        code: "unresolved_provider_merge",
        message:
          "An outstanding native merge request requires reconciliation. Check its outcome in the provider.",
      });
      for (const entry of decision?.reasons ?? []) {
        if (
          entry.code === "write_uncertain" ||
          entry.code === "prior_write_uncertain" ||
          entry.code === "provider_unavailable"
        )
          reasons.push(entry);
      }
      if (stale)
        reasons.push({
          code: "obsolete_review",
          message:
            "The previous review no longer matches this pull request or its current policy.",
        });
    }
    if (human)
      reasons.push({
        code: "previous_escalation",
        message:
          "This pull request was escalated. A human reviewer must complete the forge review and merge workflow.",
      });
    return {
      decision: {
        status: human ? "human_review_required" : "blocked",
        reviewers: human && !stale ? (decision?.reviewers ?? []) : [],
        reasons,
      },
      ...(unresolved ? { action: unresolved } : {}),
    };
  }
  if (
    pr.state === "closed" &&
    decision?.status === "merged" &&
    review?.headSha === pr.headSha
  )
    return { decision, action: "merged" };
  if (stale)
    return {
      decision: {
        status: "stale",
        reviewers: [],
        reasons: [
          {
            code: "obsolete_review",
            message:
              "The revision, pull request state or repository policy has changed since this review.",
          },
        ],
      },
    };
  if (!review || !decision) return;
  if (terminalProgress) return;
  const assessment =
    decision.status !== "stale" && review.mergePolicyVersion !== undefined
      ? review.review?.mergeAssessment
      : undefined;
  return {
    decision,
    action: review.mergeAction,
    ...(assessment
      ? {
          confidence: assessment.confidence,
          riskLevel: assessment.riskLevel,
          minimumConfidence: review.minimumConfidence,
        }
      : {}),
  };
}

/** Map saved provider metadata to public IDs and UTC timestamps without internal UUIDs. */
function pullRequestView(
  row: Awaited<ReturnType<typeof pullRequestRows>>[number],
): PullRequestView {
  const pr = row.pullRequest;
  const review = row.latestReview.publicId
    ? pullRequestReviewView(
        row.latestReview as Parameters<typeof pullRequestReviewView>[0],
      )
    : undefined;
  const merge = currentMergeView(row, review);
  if (
    merge &&
    pr.state === "open" &&
    pr.escalationComment?.creatingBody &&
    pr.escalationComment.reservationRetryAt !== undefined &&
    pr.escalationComment.reservationRetryAt <= Date.now()
  ) {
    merge.decision = {
      ...merge.decision,
      reasons: [
        {
          code: "escalation_delivery_unconfirmed",
          message:
            "Razbor could not confirm delivery of its earlier escalation comment. Check the provider request log before retrying the notification.",
        },
        ...merge.decision.reasons,
      ],
    };
  }
  return {
    id: pr.publicId,
    repositoryId: row.repositoryId,
    repositoryName: row.repositoryName,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    ...(pr.author ? { author: pr.author } : {}),
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    ...(pr.headBranch ? { headBranch: pr.headBranch } : {}),
    ...(pr.baseBranch ? { baseBranch: pr.baseBranch } : {}),
    updatedAt: pr.updatedAt.toISOString(),
    createdAt: pr.createdAt.toISOString(),
    syncedAt: pr.syncedAt.toISOString(),
    ...(review ? { latestReview: review } : {}),
    ...(merge ? { merge } : {}),
    reviewCount: row.reviewCount,
    continuousReviewActive:
      pr.state === "open" && pr.continuousReviewSince !== null,
  };
}

/** Return saved open and closed PRs, constrained by the caller's repository grants. */
export async function listPullRequests(
  database: Database,
  repositoryIds?: string[],
): Promise<PullRequestView[]> {
  return (await pullRequestRows(database, repositoryIds)).map(pullRequestView);
}

/** Read one stable PR identity and its complete newest-first code review history. */
export async function getPullRequest(
  database: Database,
  id: string,
  repositoryIds?: string[],
): Promise<PullRequestDetail | undefined> {
  publicIdSchema("pullRequest").parse(id);
  const [row] = await pullRequestRows(database, repositoryIds, id);
  if (!row) return undefined;
  const history = await database.db
    .select(pullRequestReviewSelection)
    .from(reviews)
    .innerJoin(repositories, eq(reviews.repositoryId, repositories.id))
    .leftJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .where(
      and(
        eq(reviews.repositoryId, row.pullRequest.repositoryId),
        eq(reviews.mergePullRequestId, row.pullRequest.id),
        sql`${reviews.result}->>'mode' is distinct from 'conversation'`,
      ),
    )
    .orderBy(desc(reviews.createdAt), desc(reviews.publicId));
  return {
    ...pullRequestView(row),
    reviews: history.map(pullRequestReviewView),
  };
}

/** Reject ambiguous provider snapshots before any stored PR or open state changes. */
function validateListing(changes: ForgePullRequest[]) {
  const numbers = new Set<number>();
  for (const change of changes) {
    if (
      !Number.isInteger(change.number) ||
      change.number < 1 ||
      change.number > 2147483647 ||
      numbers.has(change.number) ||
      change.state !== "open" ||
      !Number.isFinite(new Date(change.updatedAt).getTime())
    )
      throw new Error("Invalid pull request listing");
    numbers.add(change.number);
  }
}

type RefreshChange = ForgePullRequest &
  Partial<Pick<ForgeChange, "mergeBase" | "startSha">>;

/** Fill omitted detail fields from a matching listing. Readiness also depends on the observed title. */
async function readTrackedChange(
  api: Forge,
  summary: ForgePullRequest,
): Promise<RefreshChange | undefined> {
  try {
    const detail = await api.change(summary.number);
    const sameRevision =
      detail.headSha === summary.headSha &&
      detail.baseSha === summary.baseSha &&
      (!detail.headBranch ||
        !summary.headBranch ||
        detail.headBranch === summary.headBranch) &&
      (!detail.baseBranch ||
        !summary.baseBranch ||
        detail.baseBranch === summary.baseBranch);
    return {
      ...summary,
      ...detail,
      headBranch:
        detail.headBranch ?? (sameRevision ? summary.headBranch : undefined),
      baseBranch:
        detail.baseBranch ?? (sameRevision ? summary.baseBranch : undefined),
      draft:
        detail.draft ??
        (sameRevision && detail.title === summary.title
          ? summary.draft
          : undefined),
    };
  } catch (error) {
    if (error instanceof ForgeOperationError) {
      if (error.reason === "change-closed") return undefined;
      if (error.reason === "diff-pending" && api.type === "gitlab")
        return { ...summary, draft: undefined };
    }
    throw error;
  }
}

/** Read open PRs and verify their tracked revisions, optionally rereading just one contested PR. */
async function readOpenPullRequests(
  database: Database,
  repositoryId: string,
  api: Forge,
  deadline: number,
  retryNumber?: number,
) {
  const listingStartedAt = new Date();
  const listed = await api.openChanges();
  validateListing(listed);
  const selected =
    retryNumber === undefined
      ? listed
      : listed.filter((change) => change.number === retryNumber);
  const savedRows = selected.length
    ? await database.db
        .select({
          number: pullRequests.number,
          draft: pullRequests.draft,
          generation: pullRequests.triggerGeneration,
          rowVersion: sql<string>`xmin::text`,
          tracked: sql<boolean>`${pullRequests.mergeBase} is not null
            or ${pullRequests.continuousReviewSince} is not null
            or exists (select 1 from reviews r where r.merge_pull_request_id = pull_requests.id)
            or exists (select 1 from review_triggers t
              where t.repository_id = pull_requests.repository_id
              and t.change->>'number' = pull_requests.number::text)`,
        })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repositoryId),
            inArray(
              pullRequests.number,
              selected.map((change) => change.number),
            ),
          ),
        )
    : [];
  const saved = new Map(savedRows.map((row) => [row.number, row]));
  const observations = selected.map((change: RefreshChange) => ({
    change,
    before: saved.get(change.number),
    listingStartedAt,
  }));
  const changes = new Map(observations.map((row) => [row.change.number, row]));
  const tracked = observations.filter((row) => row.before?.tracked);
  const batchSize = 4;
  for (let offset = 0; offset < tracked.length; offset += batchSize) {
    if (Date.now() >= deadline) throw new Error("Provider refresh timed out");
    const batch = tracked.slice(offset, offset + batchSize);
    // Drain all in-flight reads before failing the repository or starting the next batch.
    const details = await Promise.allSettled(
      batch.map((row) => readTrackedChange(api, row.change)),
    );
    for (const [index, detail] of details.entries()) {
      if (detail.status === "rejected") throw detail.reason;
      const row = batch[index];
      if (detail.value) row.change = detail.value;
      else changes.delete(row.change.number);
    }
  }
  return changes;
}

/** Identify the provider observation to repeat after a concurrent webhook invalidates the refresh transaction. */
class ObservationChanged extends Error {
  /** Leave unrelated PR observations intact when rereading the contested PR. */
  constructor(
    readonly number: number,
    readonly state: "open" | "closed",
  ) {
    super("Pull request changed during refresh");
  }
}

/**
 * Refresh granted, active and verified forge repositories under per-repository
 * interaction locks. Confirm absent PRs are closed with a direct provider read;
 * failed or busy repositories retain their last saved state and are reported.
 */
export async function syncPullRequests(
  database: Database,
  repositoryIds?: string[],
): Promise<{ failures: string[]; syncedAt: string }> {
  repositoryIds?.forEach((repositoryId) =>
    publicIdSchema("repository").parse(repositoryId),
  );
  if (repositoryIds?.length === 0)
    return { failures: [], syncedAt: new Date().toISOString() };
  const targets = await database.db
    .select({
      repo: repositories,
      forge: forgeInstances,
      hookMode: repositoryWebhooks.mode,
    })
    .from(repositories)
    .innerJoin(forgeInstances, eq(repositories.forgeId, forgeInstances.id))
    .leftJoin(
      repositoryWebhooks,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(repositories.status, "active"),
        isNotNull(repositories.verifiedAt),
        isNotNull(repositories.externalRepositoryId),
        repositoryIds !== undefined
          ? inArray(repositories.publicId, repositoryIds)
          : undefined,
      ),
    )
    .orderBy(repositories.publicId);
  const failures: string[] = [];
  for (const { repo, forge, hookMode } of targets) {
    try {
      const completed = await interactionLock(
        database,
        `pull-requests:${repo.publicId}`,
        async () => {
          const app = await getRepositoryGithubApp(database, repo.id);
          if (
            (hookMode === "github-app" && !app) ||
            (app && forge.type !== "github")
          )
            throw new Error("GitHub App connection unavailable");
          const credential = repo.apiCredential ?? forge.credential;
          const selector = repo.observed?.fullPath ?? repo.selector;
          if (!selector) throw new Error("Verified repository unavailable");
          const connection = {
            type: forge.type,
            apiUrl: forge.apiUrl,
            webUrl: forge.webUrl,
            allowHttp: forge.allowHttp,
            token: credential
              ? await readSecret(credential, database)
              : undefined,
            ...(app ? { githubAppBot: app.bot } : {}),
          };
          const deadline = Date.now() + 20000;
          const verified = await verifyRepository(
            connection,
            selector,
            AbortSignal.timeout(20000),
          );
          if (
            verified.externalRepositoryId !== repo.externalRepositoryId ||
            verified.fullPath !== selector
          )
            throw new Error("Verified repository identity changed");
          const remainingBudget = deadline - Date.now();
          if (remainingBudget <= 0)
            throw new Error("Provider refresh timed out");
          const api = createForge(connection, selector, remainingBudget);
          const changes = await readOpenPullRequests(
            database,
            repo.id,
            api,
            deadline,
          );
          const absent = await database.db
            .select({ number: pullRequests.number })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repo.id),
                eq(pullRequests.state, "open"),
                changes.size
                  ? notInArray(pullRequests.number, [...changes.keys()])
                  : undefined,
              ),
            );
          const closedObservations = new Map<
            number,
            { rowVersion: string; observedAt: Date }
          >();
          const retriedOpen = new Set<number>();

          /** Fence a verified close against concurrent opens. A contested open PR must be accounted for on retry. */
          async function observeClosure(number: number, requireClosed = false) {
            closedObservations.delete(number);
            const [before] = await database.db
              // A same-revision open keeps the trigger generation and can even
              // share its timestamp with another webhook. Each write still has a new xmin.
              .select({ rowVersion: sql<string>`xmin::text` })
              .from(pullRequests)
              .where(
                and(
                  eq(pullRequests.repositoryId, repo.id),
                  eq(pullRequests.number, number),
                  eq(pullRequests.state, "open"),
                ),
              );
            if (!before && !requireClosed) return;
            try {
              await api.change(number);
              if (requireClosed)
                throw new Error("Open pull request missing from refresh");
            } catch (error) {
              if (
                error instanceof ForgeOperationError &&
                error.reason === "change-closed"
              ) {
                if (before)
                  closedObservations.set(number, {
                    ...before,
                    observedAt: new Date(),
                  });
              } else {
                throw error;
              }
            }
          }
          for (const { number } of absent) await observeClosure(number);

          /** Commit the repository snapshot atomically, rolling back if a tracked observation needs a fresh read. */
          async function saveSnapshot(tx: Transaction) {
            const syncedAt = new Date();
            // Also fence admission for a first observation, before a PR row exists to lock.
            const [current] = await tx
              .select({
                id: repositories.id,
                mode: repositories.reviewTriggerMode,
              })
              .from(repositories)
              .where(
                and(
                  eq(repositories.id, repo.id),
                  eq(repositories.status, "active"),
                  eq(repositories.version, repo.version),
                  eq(repositories.forgeId, forge.id),
                  eq(
                    repositories.externalRepositoryId,
                    repo.externalRepositoryId!,
                  ),
                  eq(repositories.verifiedAt, repo.verifiedAt!),
                ),
              )
              .for("update");
            if (!current) throw new Error("Repository changed during refresh");
            await lockReviewTriggerChanges(tx, repo.id);
            const [currentForge] = await tx
              .select({ updatedAt: forgeInstances.updatedAt })
              .from(forgeInstances)
              .where(eq(forgeInstances.id, forge.id))
              .for("share");
            if (currentForge?.updatedAt.getTime() !== forge.updatedAt.getTime())
              throw new Error("Forge configuration changed during refresh");
            const [hook] = await tx
              .select({
                enabled: repositoryWebhooks.enabled,
                senders: repositoryWebhooks.senders,
              })
              .from(repositoryWebhooks)
              .where(eq(repositoryWebhooks.repositoryId, repo.id));
            for (const {
              change,
              before,
              listingStartedAt,
            } of changes.values()) {
              const headBranch = sql`coalesce(excluded.head_branch, ${pullRequests.headBranch})`;
              const baseBranch = sql`coalesce(excluded.base_branch, ${pullRequests.baseBranch})`;
              const revised = sql`row(${pullRequests.state}, ${pullRequests.headSha}, ${pullRequests.baseSha},
                ${pullRequests.headBranch}, ${pullRequests.baseBranch}) is distinct from
                row(excluded.state, excluded.head_sha, excluded.base_sha, ${headBranch}, ${baseBranch})`;
              const values = {
                title: change.title,
                url: change.url,
                state: change.state,
                author: change.author ?? null,
                headSha: change.headSha,
                baseSha: change.baseSha,
                draft: change.draft ?? null,
                mergeBase: change.mergeBase ?? null,
                startSha: change.startSha ?? null,
                headBranch: change.headBranch ?? null,
                baseBranch: change.baseBranch ?? null,
                updatedAt: new Date(change.updatedAt),
                syncedAt,
              };
              if (
                forge.type === "forgejo" &&
                before &&
                before.draft !== false &&
                change.draft === false &&
                change.mergeBase
              ) {
                const existing = await latestRevisionReview(
                  tx,
                  repo.id,
                  { ...change, mergeBase: change.mergeBase },
                  false,
                );
                // A signed Forgejo title edit can admit the first review or reoffer
                // a completed manual review. Refresh only reoffers automatic results.
                if (existing?.origin !== "automatic")
                  values.draft = before.draft;
              }
              // Use the same guarded readiness for persistence and change detection.
              // A partial listing may reuse readiness only for the same revision and title.
              const draft = before?.tracked
                ? sql`${values.draft}::boolean`
                : sql`case when excluded.draft is null and not (${revised}) and ${pullRequests.title} = excluded.title
                      then ${pullRequests.draft} else excluded.draft end`;
              const changed = sql`(${revised} or row(${pullRequests.draft}, ${pullRequests.mergeBase}, ${pullRequests.startSha})
                is distinct from row(${draft}, excluded.merge_base, excluded.start_sha))`;
              const [updated] = await tx
                .insert(pullRequests)
                .values({
                  ...values,
                  publicId: publicId("pullRequest"),
                  repositoryId: repo.id,
                  number: change.number,
                  triggerGeneration: 1,
                })
                .onConflictDoUpdate({
                  target: [pullRequests.repositoryId, pullRequests.number],
                  set: {
                    ...values,
                    headBranch,
                    baseBranch,
                    draft,
                    triggerGeneration: sql`${pullRequests.triggerGeneration} + (${changed})::integer`,
                  },
                  // A webhook may have updated the row during the listing or the detail read.
                  setWhere: before
                    ? and(
                        // For tied timestamps only a detail read made after the
                        // saved row was observed can safely supersede its state.
                        change.mergeBase
                          ? lte(pullRequests.syncedAt, listingStartedAt)
                          : lt(pullRequests.syncedAt, listingStartedAt),
                        sql`${pullRequests}.xmin = ${before.rowVersion}::xid`,
                      )
                    : sql`false`,
                })
                .returning({
                  generation: pullRequests.triggerGeneration,
                  optedIn: pullRequests.continuousReviewSince,
                });
              if (
                !updated &&
                (before?.tracked || retriedOpen.has(change.number))
              )
                throw new ObservationChanged(change.number, "open");
              if (!before || !updated) continue;
              if (change.draft === true) {
                if (updated.generation !== before.generation)
                  await supersedeQueuedAutomaticReviews(
                    tx,
                    repo.id,
                    change.number,
                  );
                continue;
              }
              if (
                hook?.enabled &&
                values.draft === false &&
                change.mergeBase &&
                ((current.mode === "automatic" &&
                  allowsAutomaticAuthor(
                    verified.visibility,
                    change.author,
                    hook.senders,
                  )) ||
                  (current.mode === "opt_in_continuous" && updated.optedIn))
              )
                await rearmRefreshedPublication(
                  tx,
                  repo.id,
                  { ...change, mergeBase: change.mergeBase },
                  updated.generation,
                );
            }
            for (const [number, observation] of closedObservations) {
              const [closed] = await tx
                .update(pullRequests)
                .set({
                  state: "closed",
                  syncedAt,
                  continuousReviewSince: null,
                  reviewSessionResetAt: sql`greatest(${pullRequests.reviewSessionResetAt}, ${observation.observedAt.toISOString()}::timestamptz)`,
                  triggerGeneration: sql`${pullRequests.triggerGeneration}+1`,
                })
                .where(
                  and(
                    eq(pullRequests.repositoryId, repo.id),
                    eq(pullRequests.state, "open"),
                    sql`xmin = ${observation.rowVersion}::xid`,
                    eq(pullRequests.number, number),
                  ),
                )
                .returning({ number: pullRequests.number });
              if (!closed) throw new ObservationChanged(number, "closed");
              await supersedeQueuedAutomaticReviews(tx, repo.id, number);
            }
          }
          for (;;) {
            try {
              await database.transaction(saveSnapshot);
              return true;
            } catch (error) {
              if (
                !(error instanceof ObservationChanged) ||
                Date.now() >= deadline
              )
                throw error;
              if (error.state === "closed") {
                await observeClosure(
                  error.number,
                  retriedOpen.has(error.number),
                );
              } else {
                // Each contested open PR gets one fresh listing and detail under the same deadline.
                if (retriedOpen.has(error.number)) throw error;
                retriedOpen.add(error.number);
                const reread = await readOpenPullRequests(
                  database,
                  repo.id,
                  api,
                  deadline,
                  error.number,
                );
                const fresh = reread.get(error.number);
                if (fresh) changes.set(error.number, fresh);
                else {
                  changes.delete(error.number);
                  await observeClosure(error.number, true);
                }
              }
            }
          }
        },
      );
      if (!completed) failures.push(repo.publicId);
    } catch {
      failures.push(repo.publicId);
    }
  }
  return { failures, syncedAt: new Date().toISOString() };
}
