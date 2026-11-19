import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { publicIdSchema, type ReviewJobView } from "@razbor/contracts";
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
  syncedAt: string;
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

// Bind history to its captured repository and provider PR number. Conversations
// are not code-review runs, including while they are still queued or running.
const matchingCodeReviews = sql`
  matched_review.repository_id = ${pullRequests.repositoryId}
  and ((matched_trigger.repository_id = ${pullRequests.repositoryId} and matched_trigger.change->>'number' = ${pullRequests.number}::text)
    or (matched_trigger.review_id is null and matched_review.source->'pullRequest'->>'number' = ${pullRequests.number}::text))
  and matched_review.source->>'conversation' is null
  and matched_review.result->>'mode' is distinct from 'conversation'
`;

const latestReviewId = sql<string>`(
  select matched_review.id
  from reviews matched_review
  left join review_triggers matched_trigger on matched_trigger.review_id = matched_review.id
  where ${matchingCodeReviews}
  order by matched_review.created_at desc, matched_review.public_id desc
  limit 1
)`;

const reviewCount = sql<number>`(
  select count(*)::integer
  from reviews matched_review
  left join review_triggers matched_trigger on matched_trigger.review_id = matched_review.id
  where ${matchingCodeReviews}
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
      repositoryName: sql<string>`coalesce(${repositories.observed}->>'fullPath', ${repositories.selector}, ${repositories.configKey})`,
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

/** Map saved provider metadata to public IDs and UTC timestamps without internal UUIDs. */
function pullRequestView(
  row: Awaited<ReturnType<typeof pullRequestRows>>[number],
): PullRequestView {
  const pr = row.pullRequest;
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
    syncedAt: pr.syncedAt.toISOString(),
    ...(row.latestReview.publicId
      ? {
          latestReview: pullRequestReviewView(
            row.latestReview as Parameters<typeof pullRequestReviewView>[0],
          ),
        }
      : {}),
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
        or(
          and(
            eq(reviewTriggers.repositoryId, row.pullRequest.repositoryId),
            sql`${reviewTriggers.change}->>'number' = ${row.pullRequest.number}::text`,
          ),
          and(
            sql`${reviewTriggers.reviewId} is null`,
            sql`${reviews.source}->'pullRequest'->>'number' = ${row.pullRequest.number}::text`,
          ),
        ),
        sql`${reviews.source}->>'conversation' is null`,
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

/** List open PRs and verify the readiness and exact diff of those with review history or an active session. */
async function readOpenPullRequests(
  database: Database,
  repositoryId: string,
  api: Forge,
) {
  const listed = await api.openChanges();
  validateListing(listed);
  const savedRows = listed.length
    ? await database.db
        .select({
          number: pullRequests.number,
          draft: pullRequests.draft,
          generation: pullRequests.triggerGeneration,
          rowVersion: sql<string>`xmin::text`,
          tracked: sql<boolean>`${pullRequests.mergeBase} is not null
            or ${pullRequests.continuousReviewSince} is not null
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
              listed.map((change) => change.number),
            ),
          ),
        )
    : [];
  const saved = new Map(savedRows.map((row) => [row.number, row]));
  const changes: RefreshChange[] = [];
  for (const summary of listed) {
    if (!saved.get(summary.number)?.tracked) {
      changes.push(summary);
      continue;
    }
    // Listings do not guarantee the immutable diff refs used by retries and publication.
    // Read the complete revision for review sessions only, within the same provider deadline.
    try {
      changes.push({
        ...summary,
        ...(await api.change(summary.number)),
      });
    } catch (error) {
      if (!(error instanceof ForgeOperationError)) throw error;
      if (error.reason === "diff-pending" && api.type === "gitlab") {
        changes.push({ ...summary, draft: undefined });
      } else if (error.reason !== "change-closed") {
        throw error;
      }
      // A closed detail is omitted here and must pass the closure check below.
    }
  }
  return { changes, saved };
}

/** Identify the closure to reread after a concurrent webhook invalidates the refresh transaction. */
class ClosureChanged extends Error {
  /** Retain the provider PR number so other confirmed closures keep their original observation times. */
  constructor(readonly number: number) {
    super("Pull request changed during closure verification");
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
          const listingStartedAt = new Date();
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
          const remainingBudget =
            20000 - (Date.now() - listingStartedAt.getTime());
          if (remainingBudget <= 0)
            throw new Error("Provider refresh timed out");
          const api = createForge(connection, selector, remainingBudget);
          const { changes, saved } = await readOpenPullRequests(
            database,
            repo.id,
            api,
          );
          const absent = await database.db
            .select({ number: pullRequests.number })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repo.id),
                eq(pullRequests.state, "open"),
                changes.length
                  ? notInArray(
                      pullRequests.number,
                      changes.map((change) => change.number),
                    )
                  : undefined,
              ),
            );
          const closedObservations = new Map<
            number,
            { rowVersion: string; observedAt: Date }
          >();

          /** Fence each authoritative close read against concurrent observations, including a same-revision open. */
          async function observeClosure(number: number) {
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
            if (!before) return;
            try {
              await api.change(number);
            } catch (error) {
              if (
                error instanceof ForgeOperationError &&
                error.reason === "change-closed"
              ) {
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

          /** Either commit the entire provider snapshot or roll back the batch for a fresh close observation. */
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
            for (const change of changes) {
              const before = saved.get(change.number);
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
                    // A webhook that read the previous revision must refresh before admission.
                    triggerGeneration: sql`${pullRequests.triggerGeneration} + case
                      when (${pullRequests.state}, ${pullRequests.headSha}, ${pullRequests.baseSha}, ${pullRequests.draft}, ${pullRequests.mergeBase}, ${pullRequests.startSha})
                        is distinct from (excluded.state, excluded.head_sha, excluded.base_sha, excluded.draft, excluded.merge_base, excluded.start_sha)
                      then 1 else 0 end`,
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
                !before ||
                !updated ||
                updated.generation === before.generation
              )
                continue;
              if (change.draft === true) {
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
              if (!closed) throw new ClosureChanged(number);
              await supersedeQueuedAutomaticReviews(tx, repo.id, number);
            }
          }
          for (;;) {
            try {
              await database.transaction(saveSnapshot);
              return true;
            } catch (error) {
              if (
                !(error instanceof ClosureChanged) ||
                Date.now() - listingStartedAt.getTime() >= 20000
              )
                throw error;
              await observeClosure(error.number);
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
