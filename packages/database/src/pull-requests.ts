import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
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
  type ForgePullRequest,
} from "@razbor/forge-adapters";

import type { Database } from "@database/src/connection.js";
import { getRepositoryGithubApp } from "@database/src/github-apps.js";
import { publicId } from "@database/src/ids.js";
import { readSecret } from "@database/src/registry.js";
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
          const changes = await api.openChanges();
          validateListing(changes);
          const absent = await database.db
            .select({ number: pullRequests.number })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repo.id),
                eq(pullRequests.state, "open"),
                lte(pullRequests.syncedAt, listingStartedAt),
                changes.length
                  ? notInArray(
                      pullRequests.number,
                      changes.map((change) => change.number),
                    )
                  : undefined,
              ),
            );
          const closedNumbers: number[] = [];
          // Offset pagination can skip an open PR when earlier rows close mid-list.
          // Only its direct closed-state response permits removing it from the queue.
          for (const missing of absent) {
            try {
              await api.change(missing.number);
            } catch (error) {
              if (
                error instanceof ForgeOperationError &&
                error.reason === "change-closed"
              ) {
                closedNumbers.push(missing.number);
              } else {
                throw error;
              }
            }
          }
          const syncedAt = new Date();
          await database.transaction(async (tx) => {
            // Source-policy changes and deletion during provider I/O invalidate this snapshot.
            const [current] = await tx
              .select({ id: repositories.id })
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
              .for("share");
            if (!current) throw new Error("Repository changed during refresh");
            const [currentForge] = await tx
              .select({ updatedAt: forgeInstances.updatedAt })
              .from(forgeInstances)
              .where(eq(forgeInstances.id, forge.id))
              .for("share");
            if (currentForge?.updatedAt.getTime() !== forge.updatedAt.getTime())
              throw new Error("Forge configuration changed during refresh");
            for (const change of changes) {
              const values = {
                title: change.title,
                url: change.url,
                state: change.state,
                author: change.author ?? null,
                headSha: change.headSha,
                baseSha: change.baseSha,
                headBranch: change.headBranch ?? null,
                baseBranch: change.baseBranch ?? null,
                updatedAt: new Date(change.updatedAt),
                syncedAt,
              };
              await tx
                .insert(pullRequests)
                .values({
                  ...values,
                  publicId: publicId("pullRequest"),
                  repositoryId: repo.id,
                  number: change.number,
                })
                .onConflictDoUpdate({
                  target: [pullRequests.repositoryId, pullRequests.number],
                  set: values,
                });
            }
            if (closedNumbers.length)
              await tx
                .update(pullRequests)
                .set({ state: "closed", syncedAt })
                .where(
                  and(
                    eq(pullRequests.repositoryId, repo.id),
                    eq(pullRequests.state, "open"),
                    // A webhook can capture a new PR after this provider snapshot began.
                    lte(pullRequests.syncedAt, listingStartedAt),
                    inArray(pullRequests.number, closedNumbers),
                  ),
                );
          });
          return true;
        },
      );
      if (!completed) failures.push(repo.publicId);
    } catch {
      failures.push(repo.publicId);
    }
  }
  return { failures, syncedAt: new Date().toISOString() };
}
