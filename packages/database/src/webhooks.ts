import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  publicIdSchema,
  previousFindingsSchema,
  type PreviousFinding,
  validateFindingChecks,
} from "@razbor/contracts";
import { logger } from "@razbor/harness/logger";
import {
  verifyRepository,
  renderReview,
  forgeMarkdown,
  createForge,
  forgeWebhookSettings,
  ForgeWebhookError,
  type Forge,
  type ForgeChange,
  type ForgeWebhook,
  type RepositoryMetadata,
  ForgeOperationError,
  ForgeReadError,
} from "@razbor/forge-adapters";

import {
  acceptReviewTrigger,
  allowsAutomaticAuthor,
  lockReviewTriggerChanges,
  reviewSubmissionLock,
  reviewTriggerSession,
  triggerDelivery,
} from "@database/src/review-triggers.js";
import { reviewConversation } from "@database/src/conversation.js";
import type { Database } from "@database/src/connection.js";
import { requireContextSession } from "@database/src/contexts.js";
import {
  getRepositoryGithubApp,
  githubInstallationAccess,
} from "@database/src/github-apps.js";
import { publicId } from "@database/src/ids.js";
import { rearmStalePublication } from "@database/src/rearm-publication.js";
import {
  readSecret,
  refreshRepository,
  resolveRepository,
} from "@database/src/registry.js";
import {
  forgeInstances,
  repositories,
  repositoryWebhooks,
  storedSecrets,
  reviewTriggers,
  pullRequests,
  webhookDeliveries,
  reviews,
  dispatchOutbox,
  type Publication,
} from "@database/src/schema.js";
import {
  preparePublication,
  findingKey,
  reviewCommand,
  reviewCommandText,
} from "@database/src/presentation.js";
import { webhookSettingsSchema } from "@database/src/webhook-settings.js";
import {
  statusCommentDue,
  syncStatusComment,
} from "@database/src/review-status-comment.js";

export { webhookSettingsSchema } from "@database/src/webhook-settings.js";

/**
 * Run external interaction work under a nonblocking session advisory lock;
 * return undefined if busy and discard the connection if safe cleanup fails.
 */
export async function interactionLock<T>(
  database: Database,
  key: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  const client = await database.pool.connect();
  let discard = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(748322,hashtext($1)) as locked",
      [key],
    );
    if (!result.rows[0].locked) return;
    try {
      return await action(client);
    } finally {
      // Release the outer lock and any nested submission lock whose cleanup failed.
      await client.query("select pg_advisory_unlock_all()");
    }
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    client.release(discard);
  }
}

/**
 * Load the saved webhook, repository and forge binding for a public repository
 * ID, requiring configured webhook state.
 */
async function context(database: Database, repositoryId: string) {
  publicIdSchema("repository").parse(repositoryId);
  const [row] = await database.db
    .select({
      hook: repositoryWebhooks,
      repo: repositories,
      forge: forgeInstances,
    })
    .from(repositoryWebhooks)
    .innerJoin(
      repositories,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .innerJoin(forgeInstances, eq(repositories.forgeId, forgeInstances.id))
    .where(eq(repositories.publicId, repositoryId));
  if (!row) throw new Error("Webhook not configured");
  return row;
}

/**
 * Create a budgeted provider client using the repository's credential override
 * or shared forge reference and its verified selector.
 */
async function openAdapter(
  database: Database,
  row: Pick<Awaited<ReturnType<typeof context>>, "repo" | "forge"> & {
    hook: { mode: string } | null;
  },
  budgetMs = 20000,
  verifyBinding = false,
) {
  const f = row.forge;
  const credential = row.repo.apiCredential ?? f.credential;
  const app = await getRepositoryGithubApp(database, row.repo.id);
  if (row.hook?.mode === "github-app" && !app)
    throw new Error("GitHub App connection unavailable");
  // Deletion revokes ordinary execution tokens. Cleanup can use only the
  // exact saved App installation and repository, then verifies the provider ID.
  const retiringApp =
    row.repo.status === "deleting" &&
    verifyBinding &&
    credential &&
    "github_app" in credential &&
    credential.github_app.repository_id === row.repo.externalRepositoryId;
  const connection = retiringApp
    ? (await githubInstallationAccess(database, credential.github_app))
        .connection
    : {
        type: f.type,
        apiUrl: f.apiUrl,
        webUrl: f.webUrl,
        allowHttp: f.allowHttp,
        token: credential ? await readSecret(credential, database) : undefined,
        ...(app ? { githubAppBot: app.bot } : {}),
      };
  const selector = row.repo.observed?.fullPath ?? row.repo.selector!;
  const metadata = verifyBinding
    ? await verifyRepository(
        connection,
        selector,
        AbortSignal.timeout(budgetMs),
      )
    : undefined;
  if (
    metadata &&
    metadata.externalRepositoryId !== row.repo.externalRepositoryId
  )
    throw new ForgeOperationError("permission");
  return { api: createForge(connection, selector, budgetMs), metadata };
}

/** Open a provider client for an interaction that does not need the repository metadata. */
async function adapter(
  database: Database,
  row: Parameters<typeof openAdapter>[1],
  budgetMs = 20000,
  verifyBinding = false,
) {
  return (await openAdapter(database, row, budgetMs, verifyBinding)).api;
}

/** Resolve credentials from the saved repository, and authenticate both repository and bot before triage writes. */
export async function triageForge(database: Database, repositoryId: string) {
  const [row] = await database.db
    .select({
      repo: repositories,
      forge: forgeInstances,
      hook: repositoryWebhooks,
    })
    .from(repositories)
    .innerJoin(forgeInstances, eq(repositories.forgeId, forgeInstances.id))
    .leftJoin(
      repositoryWebhooks,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .where(eq(repositories.id, repositoryId));
  if (!row?.repo.verifiedAt || row.repo.status !== "active")
    throw new ForgeOperationError("permission");
  const api = await adapter(database, row, 30000, true);
  const bot = await api.identity();
  if (row.hook?.botId && row.hook.botId !== bot.id)
    throw new ForgeOperationError("permission");
  return { api, bot };
}

/**
 * Construct the public delivery URL from the persisted callback base and
 * opaque webhook ID.
 */
function callback(hook: typeof repositoryWebhooks.$inferSelect) {
  return `${hook.callbackBase.replace(/\/$/, "")}/webhooks/${hook.publicId}`;
}

/**
 * Locate one bot-owned published review for a saved run. Empty Forgejo follow-up
 * bodies are recovered through every frozen inline comment; partial or ambiguous
 * matches cannot authorize another publication after an uncertain write.
 * Finding history may also inspect notes from an unconfirmed GitLab submission.
 */
async function publishedReview(
  api: Forge,
  number: number,
  remoteReviews: Awaited<ReturnType<Forge["reviews"]>>,
  bot: string,
  head: string,
  reviewId: string,
  publication: Publication | null | undefined,
  includeUnconfirmedNotes = false,
) {
  const candidates = remoteReviews.filter(
    (remote) =>
      remote.user.id === bot &&
      remote.commit_id === head &&
      remote.state !== "PENDING" &&
      (remote.state !== "UNCONFIRMED" ||
        (includeUnconfirmedNotes && api.type === "gitlab")),
  );
  const marked = candidates.filter(
    (remote) =>
      remote.body.includes(`<!-- razbor:${reviewId}:result -->`) ||
      (publication?.mode === "review" && publication.remoteId === remote.id),
  );
  if (marked.length > 1)
    throw new ForgeOperationError("invalid-response", true);
  if (marked.length) return marked[0];
  const payload = publication?.reviewPayload;
  if (
    api.type !== "forgejo" ||
    publication?.mode !== "review" ||
    !payload?.recapReviewId ||
    payload.event !== "COMMENT" ||
    !payload.comments.length
  )
    return undefined;
  let found: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (candidate.body !== "") continue;
    const comments = await api.reviewComments(number, candidate.id);
    if (
      !payload.comments.every(
        (expected) =>
          comments.filter(
            (comment) =>
              comment.user?.id === bot &&
              comment.body === expected.body &&
              comment.path === expected.path &&
              comment.lineEnd === expected.lineEnd,
          ).length === 1,
      )
    )
      continue;
    if (found) throw new ForgeOperationError("invalid-response", true);
    found = candidate;
  }
  return found;
}

type MergeFindingAudit = {
  missing: Set<string>;
  assessed: Map<string, "resolved" | "open" | "uncertain">;
};

/** Record only assessments of exact prior finding identities captured by trusted review admission. */
function recordMergeFindingChecks(
  audit: MergeFindingAudit,
  review: Pick<typeof reviews.$inferSelect, "result" | "source">,
) {
  const snapshot = new Map(
    review.source.previousFindings?.map((old) => [old.id, old]),
  );
  for (const check of review.result?.findingChecks ?? []) {
    const old = snapshot.get(check.id);
    if (old)
      audit.assessed.set(
        `${old.reviewId}:${findingKey(old.finding)}`,
        check.status,
      );
  }
}

/**
 * Reconcile saved results with bot-owned published reviews, collecting
 * unresolved inline threads and published finding keys for reassessment and
 * duplicate suppression, retaining verified reply targets, and locating the
 * original editable recap. Confirmed recap-only findings retain stable assessment
 * identities until a later published review verifies their resolution.
 */
async function previousFindings(
  database: Database,
  repositoryId: string,
  number: number,
  bot: string,
  api: Forge,
  excludeReviewId?: string,
  mergeAudit?: MergeFindingAudit,
) {
  const history = await database.db
    .select({ review: reviews, publication: dispatchOutbox.publication })
    .from(reviewTriggers)
    .innerJoin(reviews, eq(reviewTriggers.reviewId, reviews.id))
    .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
    .where(
      and(
        eq(reviewTriggers.repositoryId, repositoryId),
        sql`${reviewTriggers.change}->>'number' = ${String(number)}`,
        eq(reviews.status, "completed"),
      ),
    )
    .orderBy(reviews.createdAt, reviews.publicId);
  const previous: PreviousFinding[] = [];
  const recapFindings = new Map<string, PreviousFinding>();
  const targets = new Map<
    string,
    {
      reviewId: string;
      comment: Awaited<ReturnType<Forge["reviewComments"]>>[number];
    }
  >();
  const publishedKeys = new Set<string>();
  const openOwners = new Map<string, string | null>();
  const historicalFindings = new Set<string>();
  let recapReviewId: string | undefined;
  let remoteReviews: Awaited<ReturnType<Forge["reviews"]>> | undefined;

  /** Only one exact open finding can represent a duplicate in a later frozen payload. */
  function rememberOpenOwner(key: string, reviewId: string) {
    const owner = openOwners.get(key);
    openOwners.set(
      key,
      owner === undefined || owner === reviewId ? reviewId : null,
    );
  }

  /** Give each confirmed threadless occurrence a distinct identity that a later review can reassess. */
  function recordRecapFinding(
    review: (typeof history)[number]["review"],
    finding: PreviousFinding["finding"],
  ) {
    const key = findingKey(finding);
    mergeAudit?.missing.delete(`${review.publicId}:${key}`);
    const id = `recap:${review.publicId}:${key}`;
    recapFindings.set(id, {
      id,
      reviewId: review.publicId,
      finding,
      originalHead: review.headSha,
    });
  }

  /** Retire threadless findings only when the resolving run assessed their saved identity. */
  function resolveRecapFindings(review: (typeof history)[number]["review"]) {
    for (const check of review.result?.findingChecks ?? []) {
      const old = recapFindings.get(check.id);
      if (
        check.status === "resolved" &&
        old &&
        review.source.previousFindings?.some(
          (snapshot) =>
            snapshot.id === old.id &&
            snapshot.reviewId === old.reviewId &&
            findingKey(snapshot.finding) === findingKey(old.finding),
        )
      )
        recapFindings.delete(check.id);
    }
  }

  for (const { review, publication } of history) {
    if (review.publicId === excludeReviewId || review.source.conversation)
      continue;
    // Publication may ignore an unseen remote comment. Merge authorization requires
    // a positive accounting for each persisted finding even if the actor or marker disappeared.
    if (mergeAudit)
      for (const finding of review.result?.findings ?? []) {
        const key = findingKey(finding);
        const identity = `${review.publicId}:${key}`;
        const owner = publication?.openFindingOwners?.[key];
        // The original identity is audited in its own right. Without a frozen
        // link to an earlier result, the absent marker still needs explicit proof.
        if (
          !owner ||
          publication?.state !== "published" ||
          publication.stale ||
          publication.rearmed ||
          !historicalFindings.has(`${owner}:${key}`)
        )
          mergeAudit.missing.add(identity);
        historicalFindings.add(identity);
      }
    // Include writes that reached the provider before their outbox update completed.
    remoteReviews ??= await api.reviews(number);
    // Recap-only findings have no native thread. Retain new findings for explicit
    // reassessment after the owned recap edit has been confirmed.
    if (
      publication?.mode === "recap" &&
      publication.state === "published" &&
      !publication.stale &&
      publication.remoteId === publication.reviewPayload?.recapReviewId &&
      remoteReviews.some(
        (remote) =>
          remote.id === publication.remoteId &&
          remote.user.id === bot &&
          !["PENDING", "UNCONFIRMED"].includes(remote.state),
      )
    ) {
      resolveRecapFindings(review);
      if (mergeAudit && !publication.rearmed)
        recordMergeFindingChecks(mergeAudit, review);
      const snapshotKeys = new Set(
        (review.source.previousFindings ?? []).map((old) =>
          findingKey(old.finding),
        ),
      );
      for (const finding of review.result?.findings ?? []) {
        const key = findingKey(finding);
        const independent = publication.openFindingOwners
          ? !publication.openFindingOwners[key]
          : publication.suppressedFindings?.[key] ||
            (!publishedKeys.has(key) && !snapshotKeys.has(key));
        publishedKeys.add(key);
        if (independent) recordRecapFinding(review, finding);
      }
      continue;
    }
    const remote = await publishedReview(
      api,
      number,
      remoteReviews,
      bot,
      review.headSha,
      review.publicId,
      publication,
      true,
    );
    if (!remote) continue;
    const confirmed = remote.state !== "UNCONFIRMED";
    if (
      confirmed &&
      publication?.state === "published" &&
      !publication.stale &&
      !publication.rearmed
    ) {
      resolveRecapFindings(review);
      if (mergeAudit) recordMergeFindingChecks(mergeAudit, review);
      for (const finding of review.result?.findings ?? []) {
        const key = findingKey(finding);
        if (
          publication.suppressedFindings?.[key] ||
          (publication.openFindingOwners &&
            !publication.openFindingOwners[key] &&
            publication.reviewPayload &&
            !publication.reviewPayload.comments.some(
              (comment) =>
                comment.path === finding.path &&
                comment.body.endsWith(
                  `\n<!-- razbor:${review.publicId}:${key} -->`,
                ),
            ))
        )
          recordRecapFinding(review, finding);
      }
    }
    // The first native result is the main comment, even when it starts as a
    // short clean-review message. Follow-ups targeting that comment publish
    // only inline findings and must not become another main comment.
    if (
      !recapReviewId &&
      confirmed &&
      !publication?.stale &&
      publication?.mode === "review" &&
      publication.remoteId === remote.id &&
      !publication.reviewPayload?.recapReviewId
    )
      recapReviewId = remote.id;
    if (!review.result?.findings.length) continue;
    if (confirmed)
      for (const finding of review.result.findings)
        publishedKeys.add(findingKey(finding));
    const comments = await api.reviewComments(number, remote.id);
    // A GitLab draft carries another marker after its finding marker. Only an
    // exact frozen root on the reviewed head can identify a submitted draft,
    // especially when GitLab has not confirmed the verdict.
    const evidence = new Map<(typeof comments)[number], string>();
    for (const comment of comments) {
      if (comment.user?.id !== bot) continue;
      const draft =
        api.type === "gitlab" &&
        comment.commit_id === review.headSha &&
        comments.find((item) => item.threadId === comment.threadId)?.id ===
          comment.id &&
        publication?.reviewPayload?.comments.find(
          (saved, index) =>
            saved.path === comment.path &&
            saved.lineStart === comment.lineStart &&
            saved.lineEnd === comment.lineEnd &&
            comment.body ===
              `${saved.body}\n\n<!-- razbor-gitlab-draft:${review.publicId}:${index}:${review.headSha} -->`,
        );
      if (draft) evidence.set(comment, draft.body);
      else if (confirmed) evidence.set(comment, comment.body);
    }
    const identified = new Map<
      (typeof comments)[number],
      PreviousFinding["finding"]
    >();
    for (const finding of review.result.findings) {
      const key = findingKey(finding);
      const identity = `${review.publicId}:${key}`;
      const matches = [...evidence].filter(
        ([comment, body]) =>
          comment.path === finding.path &&
          body.endsWith(`\n<!-- razbor:${identity} -->`),
      );
      if (matches.length === 1) {
        const [[comment]] = matches;
        if (comment.resolved === false) rememberOpenOwner(key, review.publicId);
        identified.set(comment, finding);
        mergeAudit?.missing.delete(identity);
      }
    }
    for (const [comment, body] of evidence) {
      const finding =
        mergeAudit || !confirmed
          ? identified.get(comment)
          : review.result.findings.find((f) =>
              body.includes(
                `<!-- razbor:${review.publicId}:${findingKey(f)} -->`,
              ),
            );
      if (finding) {
        if (!confirmed) publishedKeys.add(findingKey(finding));
        if (comment.resolved) continue;
        const id = `${remote.id}:${comment.id}`;
        targets.set(id, { reviewId: remote.id, comment });
        previous.push({
          id,
          reviewId: review.publicId,
          finding,
          originalHead: review.headSha,
          threadId: comment.threadId,
          discussion: comments
            .filter(
              (reply) =>
                reply.id !== comment.id &&
                reply.threadId === comment.threadId &&
                comments.indexOf(reply) > comments.indexOf(comment),
            )
            .map((reply) => ({
              id: reply.id,
              author: reply.user?.login ?? "deleted user",
              body: reply.body,
            })),
        });
      }
    }
  }
  for (const old of recapFindings.values())
    rememberOpenOwner(findingKey(old.finding), old.reviewId);
  // Do not silently omit old findings and then congratulate an incomplete review.
  return {
    findings: previousFindingsSchema.parse([
      ...previous,
      ...recapFindings.values(),
    ]),
    targets,
    openOwners,
    recapReviewId,
  };
}

/**
 * Require proof for each historical finding in addition to Phase 2's live outstanding
 * threads and recaps. A missing remote finding or bot identity is inconclusive; only
 * a later, identity-bound resolved assessment can discharge that missing evidence.
 */
export async function triageOutstanding(
  database: Database,
  repoId: string,
  number: number,
  botId: string,
  api: Forge,
  review: Pick<typeof reviews.$inferSelect, "publicId" | "result" | "source">,
) {
  const audit: MergeFindingAudit = {
    missing: new Set(
      review.source.previousFindings?.map(
        (old) => `${old.reviewId}:${findingKey(old.finding)}`,
      ),
    ),
    assessed: new Map(),
  };
  const { findings } = await previousFindings(
    database,
    repoId,
    number,
    botId,
    api,
    review.publicId,
    audit,
  );
  recordMergeFindingChecks(audit, review);
  const unresolved = new Set(
    [...audit.missing].filter((key) => audit.assessed.get(key) !== "resolved"),
  );
  const currentChecks = new Map(
    review.result?.findingChecks?.map((check) => [check.id, check.status]),
  );
  for (const finding of findings) {
    const key = findingKey(finding.finding);
    // A native thread in this live list is open, including when a maintainer
    // reopened it after the model's assessment. Recap-only findings lack that signal.
    if (
      finding.threadId ||
      currentChecks.get(finding.id) !== "resolved" ||
      !review.source.previousFindings?.some(
        (old) =>
          old.id === finding.id &&
          old.reviewId === finding.reviewId &&
          findingKey(old.finding) === key,
      )
    )
      unresolved.add(`${finding.reviewId}:${key}`);
  }
  // Historical or incomplete results may predate validation at completion.
  // Unbound or missing assessments cannot be cleared by a provider read.
  try {
    if (review.result)
      validateFindingChecks(review.result, review.source.previousFindings);
  } catch {
    return Math.max(unresolved.size, 1);
  }
  return unresolved.size;
}

/**
 * Expose webhook status and manual setup guidance without returning its
 * signing secret.
 */
export async function webhookView(database: Database, repositoryId: string) {
  publicIdSchema("repository").parse(repositoryId);
  const [h] = await database.db
    .select({ hook: repositoryWebhooks, provider: forgeInstances.type })
    .from(repositoryWebhooks)
    .innerJoin(
      repositories,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .innerJoin(forgeInstances, eq(repositories.forgeId, forgeInstances.id))
    .where(eq(repositories.publicId, repositoryId));
  if (!h) return null;
  const hook = h.hook;
  const app =
    hook.mode === "github-app"
      ? await getRepositoryGithubApp(database, hook.repositoryId)
      : undefined;
  const settings = forgeWebhookSettings(h.provider);
  return {
    id: hook.publicId,
    provider: h.provider,
    label: settings.label,
    enabled: hook.enabled,
    managedBy: hook.managedBy,
    mode: hook.mode,
    callbackBase: hook.callbackBase,
    callbackUrl: app?.callbackUrl ?? callback(hook),
    appUrl: app?.appUrl ?? null,
    reviewCommand: reviewCommandText(),
    permittedSenders: hook.senders,
    secretConfigured: true,
    remoteId: hook.remoteId,
    setup: hook.setup,
    lastDelivery: hook.lastDelivery,
    lastDeliveryAt: hook.lastDeliveryAt?.toISOString() ?? null,
    manual: {
      type: settings.label,
      contentType: "application/json",
      events: settings.events,
      secretHeader: settings.secretHeader,
      secret:
        "Use the configured webhook secret. Saved secrets are never returned here.",
    },
  };
}

// Webhook admission compares millisecond timestamps across provider reads.
// Make consecutive edits distinguishable even within the same clock tick.
const nextHookRevision = sql`greatest(date_trunc('milliseconds', clock_timestamp()),
  date_trunc('milliseconds', ${repositoryWebhooks.updatedAt}) + interval '1 millisecond')`;

/** Advance the admission fence only when saved settings or the signing credential change. */
function webhookSettingsRevision(
  old: typeof repositoryWebhooks.$inferSelect | undefined,
  settings: z.infer<typeof webhookSettingsSchema>,
  rotated = false,
) {
  if (!old) return new Date();
  if (
    rotated ||
    old.enabled !== settings.enabled ||
    old.callbackBase !== settings.callback_base.replace(/\/$/, "") ||
    JSON.stringify(old.secret) !== JSON.stringify(settings.secret) ||
    JSON.stringify(old.senders) !== JSON.stringify(settings.permitted_senders)
  )
    return nextHookRevision;
  return undefined;
}

/**
 * Save validated settings for an active hosted repository while enforcing
 * configuration ownership and preserving App-owned connection credentials.
 */
export async function configureWebhook(
  database: Database,
  repositoryId: string,
  input: unknown,
  managedBy = "ui",
) {
  const settings = webhookSettingsSchema.parse(input);
  publicIdSchema("repository").parse(repositoryId);
  await database.transaction(async (tx) => {
    const [repo] = await tx
      .select()
      .from(repositories)
      .where(eq(repositories.publicId, repositoryId))
      .for("update");
    if (!repo?.forgeId || repo.status !== "active")
      throw new Error("Active hosted repository required");
    const [old] = await tx
      .select()
      .from(repositoryWebhooks)
      .where(eq(repositoryWebhooks.repositoryId, repo.id));
    if (old && old.managedBy !== managedBy)
      throw new Error(
        "Webhook settings are owned by another configuration source",
      );
    await lockReviewTriggerChanges(tx, repo.id);
    if (
      old?.mode === "github-app" &&
      (settings.callback_base.replace(/\/$/, "") !== old.callbackBase ||
        !("githubApp" in settings.secret) ||
        !("githubApp" in old.secret) ||
        settings.secret.githubApp !== old.secret.githubApp)
    )
      throw new Error("GitHub App webhook credentials are managed by the App");
    // A callback change is applied only to the persisted owned hook, never an unrelated integration.
    const values = {
      enabled: settings.enabled,
      callbackBase: settings.callback_base.replace(/\/$/, ""),
      secret: settings.secret,
      senders: settings.permitted_senders,
      updatedAt: webhookSettingsRevision(old, settings),
      setup:
        old?.mode === "manual" &&
        old.callbackBase === settings.callback_base.replace(/\/$/, "") &&
        JSON.stringify(old.secret) === JSON.stringify(settings.secret)
          ? old.setup
          : old?.mode === "manual"
            ? "manual"
            : "pending",
    };
    if (old)
      await tx
        .update(repositoryWebhooks)
        .set(values)
        .where(eq(repositoryWebhooks.id, old.id));
    else
      await tx.insert(repositoryWebhooks).values({
        ...values,
        managedBy,
        repositoryId: repo.id,
        publicId: publicId("webhook"),
      });
  });
}

/**
 * Allow in-place rotation only for a stored signing reference that is not
 * shared with API or Git authentication.
 */
function canRotateSigningSecret(
  secret: typeof repositoryWebhooks.$inferSelect.secret | undefined,
  repo: typeof repositories.$inferSelect,
): secret is { stored: string } {
  if (!secret || !("stored" in secret)) return false;
  const sharedApiToken =
    repo.apiCredential &&
    "stored" in repo.apiCredential &&
    repo.apiCredential.stored === secret.stored;
  const sharedGitToken =
    repo.git.credentials?.kind === "https" &&
    repo.git.credentials.token_id === secret.stored;
  return !sharedApiToken && !sharedGitToken;
}

/**
 * Save UI-owned settings and signing credentials, then reconcile connection
 * access. App-owned credentials cannot be changed per repository.
 * Console callers supply context and session to authorize its owner before taking locks.
 */
export async function saveWebhookFromUi(
  database: Database,
  repositoryId: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
) {
  const data = z
    .object({
      enabled: z.boolean(),
      callback_base: z.string().optional(),
      permitted_senders: z.array(z.string()),
      signing_secret: z
        .string()
        .min(32)
        .max(256)
        .regex(/^[^\r\n\0]+$/)
        .optional(),
    })
    .strict()
    .parse(input);
  publicIdSchema("repository").parse(repositoryId);
  let generated: string | undefined;
  await database.transaction(async (tx) => {
    if (sessionToken !== undefined)
      await requireContextSession(
        tx,
        sessionToken,
        contextId ?? "",
        "repositories",
      );
    const [repo] = await tx
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.publicId, repositoryId),
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      )
      .for("update");
    if (!repo?.forgeId || repo.status !== "active")
      throw new Error("Active hosted repository required");
    const [old] = await tx
      .select()
      .from(repositoryWebhooks)
      .where(eq(repositoryWebhooks.repositoryId, repo.id))
      .for("update");
    if (old && old.managedBy !== "ui")
      throw new Error("File-managed settings are read-only");
    await lockReviewTriggerChanges(tx, repo.id);
    if (
      old?.mode === "github-app" &&
      (data.signing_secret ||
        (data.callback_base !== undefined &&
          data.callback_base.replace(/\/$/, "") !== old.callbackBase))
    )
      throw new Error("GitHub App webhook credentials are managed by the App");
    let secret = old?.secret;
    if (!secret || data.signing_secret) {
      const value = data.signing_secret ?? randomBytes(32).toString("hex");
      // Reuse an owned stored signing reference when rotating it. Existing
      // file/env references remain compatible until their first UI rotation.
      if (canRotateSigningSecret(secret, repo)) {
        const [updated] = await tx
          .update(storedSecrets)
          .set({ value })
          .where(
            and(
              eq(storedSecrets.id, secret.stored),
              eq(storedSecrets.repositoryId, repo.id),
            ),
          )
          .returning({ id: storedSecrets.id });
        if (!updated) throw new Error("Stored webhook secret unavailable");
      } else {
        const [stored] = await tx
          .insert(storedSecrets)
          .values({ repositoryId: repo.id, value })
          .returning({ id: storedSecrets.id });
        secret = { stored: stored.id };
      }
      if (!data.signing_secret) generated = value;
    }
    const settings = webhookSettingsSchema.parse({
      enabled: data.enabled,
      callback_base:
        old?.mode === "github-app" ? old.callbackBase : data.callback_base,
      permitted_senders: data.permitted_senders,
      secret,
    });
    const values = {
      enabled: settings.enabled,
      callbackBase: settings.callback_base.replace(/\/$/, ""),
      secret: settings.secret,
      senders: settings.permitted_senders,
      setup:
        old?.mode === "manual" &&
        !data.signing_secret &&
        old.callbackBase === settings.callback_base.replace(/\/$/, "")
          ? old.setup
          : old?.mode === "manual"
            ? "manual"
            : "pending",
      updatedAt: webhookSettingsRevision(old, settings, !!data.signing_secret),
    };
    if (old)
      await tx
        .update(repositoryWebhooks)
        .set(values)
        .where(eq(repositoryWebhooks.id, old.id));
    else
      await tx.insert(repositoryWebhooks).values({
        ...values,
        repositoryId: repo.id,
        managedBy: "ui",
        publicId: publicId("webhook"),
      });
  });
  await reconcileWebhook(database, repositoryId);
  return {
    webhook: await webhookView(database, repositoryId),
    ...(generated ? { generatedSecret: generated } : {}),
  };
}

/**
 * Refresh repository identity under a lock, mutating only managed remote
 * hooks. Manual setup needs a signed delivery; App setup uses its binding.
 */
export async function reconcileWebhook(
  database: Database,
  repositoryId: string,
) {
  await interactionLock(database, `repository:${repositoryId}`, async () => {
    await interactionLock(database, `hook:${repositoryId}`, async () => {
      let row = await context(database, repositoryId);
      if (row.repo.status !== "active") return;
      try {
        await refreshRepository(database, repositoryId);
        row = await context(database, repositoryId);
        if (row.repo.status !== "active") return;
        const api = await adapter(database, row);
        const bot = await api.identity();
        await database.db
          .update(repositoryWebhooks)
          .set({ botId: bot.id, updatedAt: nextHookRevision })
          .where(
            and(
              eq(repositoryWebhooks.id, row.hook.id),
              sql`${repositoryWebhooks.botId} is distinct from ${bot.id}`,
            ),
          );
        const remoteId =
          row.hook.mode === "managed"
            ? await api.reconcileHook(
                callback(row.hook),
                await readSecret(row.hook.secret, database),
                row.hook.enabled,
                row.hook.remoteId,
              )
            : null;
        await database.db
          .update(repositoryWebhooks)
          .set({
            remoteId,
            setup: !row.hook.enabled
              ? "disabled"
              : row.hook.mode === "manual"
                ? sql`case when ${repositoryWebhooks.setup} = 'ready' then 'ready' else 'manual' end`
                : "ready",
            updatedAt: sql`case when ${repositoryWebhooks.remoteId} is distinct from ${remoteId}
              then ${nextHookRevision} else ${repositoryWebhooks.updatedAt} end`,
          })
          .where(eq(repositoryWebhooks.id, row.hook.id));
      } catch (error) {
        await database.db
          .update(repositoryWebhooks)
          .set({
            setup:
              error instanceof ForgeOperationError
                ? error.reason
                : "configuration-error",
          })
          .where(eq(repositoryWebhooks.id, row.hook.id));
      }
    });
  });
  return webhookView(database, repositoryId);
}

/**
 * Remove only managed provider hooks during repository deletion. Manual hooks
 * and shared App hooks remain with their owner. Defer removal while locked or
 * while a temporary comment still needs its saved credentials for cleanup.
 */
export async function removeRepositoryWebhook(
  database: Database,
  repositoryId: string,
) {
  publicIdSchema("repository").parse(repositoryId);
  const removed = await interactionLock(
    database,
    `repository:${repositoryId}`,
    async () =>
      interactionLock(database, `hook:${repositoryId}`, async () => {
        const [repository] = await database.db
          .select()
          .from(repositories)
          .where(eq(repositories.publicId, repositoryId));
        if (!repository) return true;
        if (repository.status !== "deleting")
          throw new Error("Repository must be deleting before webhook cleanup");
        const [hook] = await database.db
          .select()
          .from(repositoryWebhooks)
          .where(eq(repositoryWebhooks.repositoryId, repository.id));
        if (!hook) return true;
        const drained = await interactionLock(
          database,
          `status:${repositoryId}`,
          async () => {
            const [pending] = await database.db
              .select({
                error: sql<
                  string | null
                >`${dispatchOutbox.statusComment}->>'error'`,
              })
              .from(dispatchOutbox)
              .innerJoin(reviews, eq(reviews.id, dispatchOutbox.reviewId))
              .where(
                and(
                  eq(reviews.repositoryId, repository.id),
                  sql`${dispatchOutbox.statusComment} is not null`,
                ),
              )
              .orderBy(
                sql`case when ${dispatchOutbox.statusComment}->>'error' = 'status-comment-owner-changed' then 0 else 1 end`,
              )
              .limit(1);
            if (pending?.error === "status-comment-owner-changed") {
              const message =
                "Remove the previous bot's temporary review comment on the forge or restore its credentials so cleanup can finish.";
              if (repository.setupError !== message) {
                await database.db
                  .update(repositories)
                  .set({ setupError: message })
                  .where(
                    and(
                      eq(repositories.id, repository.id),
                      eq(repositories.status, "deleting"),
                    ),
                  );
              }
            }
            return !pending;
          },
        );
        if (!drained) return false;
        if (hook.mode !== "managed") {
          await database.db
            .update(repositoryWebhooks)
            .set({ enabled: false, setup: "disabled", updatedAt: new Date() })
            .where(eq(repositoryWebhooks.id, hook.id));
          return true;
        }
        // Reconciliation commits provider identity before it can create or
        // adopt a remote hook, and application writes never clear that identity.
        // An unverified import without a recorded hook ID therefore owns no
        // provider hook; any independently configured manual hook stays intact.
        if (!repository.externalRepositoryId && !hook.remoteId) return true;
        const row = await context(database, repositoryId);
        const api = await adapter(database, row);
        await api.removeHook(callback(hook), hook.remoteId);
        await database.db
          .update(repositoryWebhooks)
          .set({
            enabled: false,
            remoteId: null,
            setup: "disabled",
            updatedAt: new Date(),
          })
          .where(eq(repositoryWebhooks.id, hook.id));
        return true;
      }),
  );
  return removed === true;
}

/**
 * Apply and reconcile each declared repository webhook using the registry's
 * configuration owner.
 */
export async function applyWebhookSettings(
  database: Database,
  registry: {
    registry: { key: string };
    repositories: Record<
      string,
      { webhook?: z.infer<typeof webhookSettingsSchema> }
    >;
  },
) {
  for (const [key, repo] of Object.entries(registry.repositories))
    if (repo.webhook) {
      const id = await resolveRepository(database, key);
      if (!id) throw new Error("Registered repository required");
      await configureWebhook(database, id, repo.webhook, registry.registry.key);
      await reconcileWebhook(database, id);
    }
}

/** Reduce provider, schema and unknown failures to safe diagnostic categories. */
function webhookErrorReason(error: unknown) {
  if (error instanceof ForgeOperationError) return error.reason;
  if (error instanceof z.ZodError) return "invalid-data";
  return "unavailable";
}

/** Queue policy-authorized work for the current revision and greet a newly opened PR once. */
async function handlePullRequest(
  database: Database,
  row: Awaited<ReturnType<typeof context>>,
  event: Exclude<ForgeWebhook, { kind: "push" | "ping" | "comment" }>,
  setStage?: (stage: string) => void,
): Promise<[number, string]> {
  const h = row.hook;
  const botId = h.botId;
  if (!botId) return [503, "bot-identity-unavailable"];
  const session = await reviewTriggerSession(
    database,
    row.repo.id,
    event.number,
    row.forge.type === "gitlab" ? h.id : undefined,
  );
  setStage?.("verify-repository");
  const { api, metadata } = await openAdapter(database, row, 30000, true);
  setStage?.("read-pull-request");
  let change: ForgeChange | undefined;
  try {
    change = await api.change(event.number);
    if (change.number !== event.number)
      return [403, "pull-request-identity-mismatch"];
  } catch (error) {
    if (
      row.forge.type === "gitlab" &&
      error instanceof ForgeOperationError &&
      error.reason === "diff-pending"
    ) {
      setStage?.("persist-deferred-merge-request");
      const saved = await acceptReviewTrigger(
        database,
        row.repo,
        h,
        row.forge.type,
        {
          event,
          ...session.version,
          waitingForDiff: true,
        },
      );
      if (saved.retry) return [409, "competing-observation"];
      return [202, "merge-request-diff-pending"];
    }
    if (
      !(error instanceof ForgeOperationError) ||
      error.reason !== "change-closed"
    )
      throw error;
  }
  const automaticAuthorPermitted = allowsAutomaticAuthor(
    metadata?.visibility,
    change?.author,
    h.senders,
  );
  const eligible =
    change?.draft === false &&
    event.kind !== "closed" &&
    event.kind !== "reopened" &&
    ((row.repo.reviewTriggerMode === "automatic" && automaticAuthorPermitted) ||
      (row.repo.reviewTriggerMode === "opt_in_continuous" &&
        session.continuousReviewSince));
  /** Read prior published findings only after the event is eligible to queue work. */
  const readHistory = () => {
    setStage?.("read-previous-findings");
    return previousFindings(database, row.repo.id, event.number, botId, api);
  };
  const previous = eligible ? (await readHistory()).findings : undefined;

  setStage?.("persist-lifecycle");
  let accepted = await acceptReviewTrigger(
    database,
    row.repo,
    h,
    row.forge.type,
    {
      event,
      change,
      automaticAuthorPermitted,
      ...session.version,
      previous,
    },
  );
  if (accepted.historyGeneration !== undefined) {
    const history = await readHistory();
    setStage?.("persist-lifecycle");
    accepted = await acceptReviewTrigger(
      database,
      row.repo,
      h,
      row.forge.type,
      {
        event,
        change,
        automaticAuthorPermitted,
        previous: history.findings,
        generation: accepted.historyGeneration,
      },
    );
  }
  if ("retry" in accepted) return [409, "competing-observation"];
  if ("duplicate" in accepted) return [202, "duplicate-delivery"];
  if (event.kind === "opened" && change) {
    const greeting = change.author ? `Hey @${change.author}! ` : "";
    // Greeting is optional. Admission already committed, even if the bot lacks comment permissions.
    try {
      await interactionLock(
        database,
        `repository:${row.repo.publicId}`,
        async () => {
          const current = await context(database, row.repo.publicId);
          if (
            current.repo.status !== "active" ||
            !current.hook.enabled ||
            current.hook.updatedAt.getTime() !== h.updatedAt.getTime()
          )
            return;
          const marker = `<!-- razbor:${row.repo.publicId}:${event.number}:welcome -->`;
          const existing = (await api.comments(event.number)).some(
            (c) => c.user.id === h.botId && c.body.includes(marker),
          );
          if (existing) return;
          const instructions = {
            manual: `Request a review by commenting \`${reviewCommandText()}\`.`,
            opt_in_continuous: `Comment \`${reviewCommandText()}\` to start continuous review for this pull request. I'll review subsequent revisions automatically.`,
            automatic: automaticAuthorPermitted
              ? "I'll review this pull request automatically when it is ready and when its source revision changes."
              : `A permitted user can request a review by commenting \`${reviewCommandText()}\`.`,
          };
          await api.postComment(
            event.number,
            `${greeting}${instructions[current.repo.reviewTriggerMode]}\n\n${marker}`,
          );
        },
      );
    } catch (error) {
      logger.warn(
        { hookId: h.publicId, reason: webhookErrorReason(error) },
        "pull request greeting unavailable",
      );
    }
  }
  return ["reviewId" in accepted ? 202 : 200, "pull-request-accepted"];
}

/**
 * Authenticate and validate a provider delivery, then handle index refresh,
 * greeting or durable review creation with repository, sender and duplicate
 * checks; return an HTTP status. App hooks require the trusted shared ingress
 * dispatch context after installation and repository routing validation.
 */
export async function acceptWebhook(
  database: Database,
  hookId: string,
  raw: Uint8Array,
  headers: Record<string, string | undefined>,
  refreshIndex?: (repositoryId: string) => Promise<unknown>,
  githubAppDispatch?: { githubAppId: string },
) {
  publicIdSchema("webhook").parse(hookId);
  const log = logger.child({ hookId });
  /**
   * Log a safe webhook outcome category and return the corresponding HTTP
   * status.
   */
  const outcome = (status: number, reason: string) => {
    if (status >= 400) log.warn({ status, reason }, "webhook rejected");
    else log.info({ status, reason }, "webhook handled");
    return status;
  };

  const [binding] = await database.db
    .select({ repoId: repositories.publicId })
    .from(repositoryWebhooks)
    .innerJoin(
      repositories,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .where(eq(repositoryWebhooks.publicId, hookId));
  if (!binding) return outcome(404, "unknown-hook");
  const row = await context(database, binding.repoId);
  const h = row.hook;
  if (h.mode === "github-app") {
    if (!githubAppDispatch) return outcome(404, "app-webhook-required");
    const app = await getRepositoryGithubApp(database, row.repo.id);
    if (!app || app.id !== githubAppDispatch?.githubAppId)
      return outcome(404, "app-webhook-required");
  } else if (githubAppDispatch) {
    return outcome(404, "app-repository-required");
  }
  if (row.repo.status !== "active" || !h.enabled)
    return outcome(404, "disabled-hook");
  let normalizedEvent: ForgeWebhook | undefined;
  try {
    const provider = await adapter(database, row);
    normalizedEvent = provider.webhook(
      raw,
      headers,
      await readSecret(h.secret, database),
    );
  } catch (error) {
    if (error instanceof ForgeWebhookError)
      return outcome(error.status, error.reason);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return outcome(400, "invalid-payload");
    throw error;
  }
  if (!normalizedEvent) return outcome(204, "ignored-event");
  if (normalizedEvent.repositoryId !== row.repo.externalRepositoryId)
    return outcome(403, "repository-not-permitted");
  const delivery = normalizedEvent.deliveryId;
  // Signed repository delivery proves manual setup. App adapters also mint a
  // fresh scoped token, so a delivery can prove access restored after revocation.
  // Keep updatedAt intact: it fences settings changes during review creation.
  if (h.mode === "manual" || h.mode === "github-app")
    await database.db
      .update(repositoryWebhooks)
      .set({ setup: "ready" })
      .where(
        and(
          eq(repositoryWebhooks.id, h.id),
          eq(repositoryWebhooks.updatedAt, h.updatedAt),
          eq(repositoryWebhooks.enabled, true),
        ),
      );
  if (normalizedEvent.kind === "ping") {
    const accepted = await database.transaction(async (tx) => {
      const inserted = await tx
        .insert(webhookDeliveries)
        .values({ webhookId: h.id, deliveryId: delivery })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });
      if (!inserted.length) return false;
      await tx
        .update(repositoryWebhooks)
        .set({ lastDelivery: "accepted", lastDeliveryAt: new Date() })
        .where(eq(repositoryWebhooks.id, h.id));
      return true;
    });
    return accepted
      ? outcome(200, "ping-accepted")
      : outcome(202, "duplicate-delivery");
  }
  let stage = "parse-event";
  /**
   * Refresh only the registered indexed branch, recording delivery success
   * after indexing completes so failures remain retryable.
   */
  async function handlePush() {
    const push = normalizedEvent?.kind === "push" ? normalizedEvent : undefined;
    if (!push) return outcome(204, "deleted-ref");
    if (push.repositoryId !== row.repo.externalRepositoryId)
      return outcome(403, "repository-not-permitted");
    // Match the remote branch actually fetched by the indexer, even when
    // the local tracking branch has a different name.
    const branch = row.repo.git.upstream.split("/").slice(3).join("/");
    if (push.ref !== `refs/heads/${branch}`)
      return outcome(204, "not-indexed-branch");
    stage = "refresh-index";
    const result = await interactionLock(
      database,
      `repository:${row.repo.publicId}`,
      async () => {
        const current = await context(database, row.repo.publicId);
        if (current.repo.status !== "active" || !current.hook.enabled)
          return outcome(404, "repository-unavailable");
        if (!current.repo.codebaseMemoryEnabled)
          return outcome(204, "index-disabled");
        const [duplicate] = await database.db
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.webhookId, h.id),
              eq(webhookDeliveries.deliveryId, delivery),
            ),
          );
        if (duplicate) return outcome(202, "duplicate-delivery");
        if (!refreshIndex) throw new Error("index refresh is not configured");
        await refreshIndex(row.repo.publicId);
        // Failed refreshes remain retryable. Only completed indexing is
        // recorded as a handled delivery.
        await database.transaction(async (tx) => {
          await tx
            .insert(webhookDeliveries)
            .values({ webhookId: h.id, deliveryId: delivery })
            .onConflictDoNothing();
          await tx
            .update(repositoryWebhooks)
            .set({ lastDelivery: "accepted", lastDeliveryAt: new Date() })
            .where(eq(repositoryWebhooks.id, h.id));
        });
        return outcome(200, "push-index-refreshed");
      },
    );
    return result ?? outcome(503, "push-refresh-in-progress");
  }

  /**
   * Reverify the bound provider identity and private visibility before
   * allowing wildcard sender access.
   */
  async function wildcardRepositoryIsPrivate() {
    const f = row.forge;
    const credential = row.repo.apiCredential ?? f.credential;
    const metadata = await verifyRepository(
      {
        type: f.type,
        apiUrl: f.apiUrl,
        webUrl: f.webUrl,
        allowHttp: f.allowHttp,
        token: credential ? await readSecret(credential, database) : undefined,
      },
      row.repo.observed?.fullPath ?? row.repo.selector!,
      AbortSignal.timeout(20000),
    );
    return (
      metadata.externalRepositoryId === row.repo.externalRepositoryId &&
      metadata.visibility === "private"
    );
  }

  /** Admit the verified command at the observed session version before any closed-PR reply can be sent. */
  async function handleClosedComment(
    api: Forge,
    event: Extract<ForgeWebhook, { kind: "comment" }>,
    version: Awaited<ReturnType<typeof reviewTriggerSession>>["version"],
  ) {
    if (!reviewCommand(event.body)) return outcome(204, "closed-pull-request");
    stage = "verify-comment";
    // The adapter verifies that this comment belongs to the requested change.
    const comment = await api.comment(event.commentId, event.number);
    if (
      comment.id !== event.commentId ||
      comment.user.id !== event.senderId ||
      comment.user.login.toLowerCase() !== event.sender.toLowerCase() ||
      !reviewCommand(comment.body)
    )
      return outcome(403, "comment-does-not-match-command");
    const accepted = await acceptReviewTrigger(
      database,
      row.repo,
      h,
      row.forge.type,
      { event, ...version },
    );
    if ("retry" in accepted) return 409;
    if (!accepted.closedReplyId) return outcome(202, "duplicate-delivery");
    return explainClosedCommand(api, event, accepted.closedReplyId);
  }

  /** Deliver the recorded closed-command decision and reconcile a possibly successful POST before retrying. */
  async function explainClosedCommand(
    api: Forge,
    event: Extract<ForgeWebhook, { kind: "comment" }>,
    receiptId: string,
  ) {
    stage = "explain-closed-pull-request";
    const result = await interactionLock(
      database,
      `repository:${row.repo.publicId}`,
      async () => {
        const current = await context(database, row.repo.publicId);
        if (
          current.repo.status !== "active" ||
          !current.hook.enabled ||
          current.hook.updatedAt.getTime() !== h.updatedAt.getTime()
        )
          return outcome(404, "repository-unavailable");
        const [receipt] = await database.db
          .select({ pending: webhookDeliveries.pendingAction })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, receiptId));
        if (!receipt?.pending) return outcome(202, "duplicate-delivery");
        /** Persist the reply fence independently of the command admission. */
        const save = (
          pendingAction: "closed-reply" | "posting-closed-reply" | null,
        ) =>
          database.db
            .update(webhookDeliveries)
            .set({ pendingAction })
            .where(eq(webhookDeliveries.id, receiptId));
        const marker = `<!-- razbor:${row.repo.publicId}:${event.number}:${event.commentId}:closed -->`;
        const existing = (
          await api.comments(event.number, { complete: true })
        ).some(
          (reply) => reply.user.id === h.botId && reply.body.includes(marker),
        );
        if (!existing) {
          if (receipt.pending === "posting-closed-reply")
            return outcome(503, "closed-pull-request-reply-unconfirmed");
          await save("posting-closed-reply");
          try {
            await api.postComment(
              event.number,
              `This pull request was closed or merged when I checked the command, so I didn't start a review. Request a review on an open pull request with \`${reviewCommandText()}\`.\n\n${marker}`,
            );
          } catch (error) {
            if (error instanceof ForgeOperationError && !error.uncertain)
              await save("closed-reply");
            throw error;
          }
        }
        await save(null);
        return outcome(200, "closed-pull-request-explained");
      },
    );
    return result ?? outcome(503, "closed-pull-request-reply-in-progress");
  }

  /**
   * Verify a permitted command or native review reply against current provider
   * data, then snapshot source and reviewer state into one durable,
   * deduplicated review.
   */
  async function handleComment(closedReplyId?: string) {
    const event =
      normalizedEvent?.kind === "comment" ? normalizedEvent : undefined;
    // Bot replies can contain the command as usage guidance. Never enqueue them.
    if (event?.senderId === h.botId) return outcome(204, "own-comment");
    if (!event) return outcome(204, "not-a-created-pr-comment");
    if (
      !h.botId ||
      event.repositoryId !== row.repo.externalRepositoryId ||
      !h.senders.some(
        (s) => s === "*" || s.toLowerCase() === event.sender.toLowerCase(),
      )
    )
      return outcome(403, "repository-or-sender-not-permitted");
    if (h.senders.includes("*")) {
      stage = "verify-repository";
      if (!(await wildcardRepositoryIsPrivate()))
        return outcome(403, "wildcard-requires-private-repository");
    }
    const api = await adapter(database, row, 30000, !h.senders.includes("*"));
    if (closedReplyId) return explainClosedCommand(api, event, closedReplyId);
    const session = await reviewTriggerSession(
      database,
      row.repo.id,
      event.number,
      row.forge.type === "gitlab" ? h.id : undefined,
    );
    stage = "read-pull-request";
    let change: ForgeChange;
    try {
      change = await api.change(event.number);
    } catch (error) {
      if (
        error instanceof ForgeOperationError &&
        error.reason === "change-closed"
      )
        return handleClosedComment(api, event, session.version);
      throw error;
    }
    if (change.number !== event.number)
      return outcome(403, "pull-request-identity-mismatch");
    stage = "verify-reply-thread";
    // Check native replies before commands: even a reply saying "review" must
    // not start a full review instead of answering in the original thread.
    const conversation = await reviewConversation(
      database,
      row.repo.id,
      change,
      h.botId,
      api,
      event,
    );
    if (
      conversation &&
      conversation.reply.author.toLowerCase() !== event.sender.toLowerCase()
    )
      return outcome(403, "comment-author-changed");
    let commandAt: string | undefined;
    if (!conversation) {
      if (!reviewCommand(event.body))
        return outcome(204, "not-a-review-command-or-reply");
      stage = "verify-comment";
      const comment = await api.comment(event.commentId, event.number);
      commandAt = comment.createdAt;
      if (
        comment.id !== event.commentId ||
        comment.user.id !== event.senderId ||
        comment.user.login.toLowerCase() !== event.sender.toLowerCase() ||
        !reviewCommand(comment.body) ||
        // Forgejo PR comments populate pull_request_url and leave issue_url empty.
        (comment.pull_request_url !== change.url &&
          !comment.issue_url.endsWith(`/issues/${event.number}`))
      )
        return outcome(403, "comment-does-not-match-command");
    }
    stage = "read-previous-findings";
    const previous = conversation
      ? undefined
      : (
          await previousFindings(
            database,
            row.repo.id,
            change.number,
            h.botId,
            api,
          )
        ).findings;
    stage = "persist-review";
    const accepted = await acceptReviewTrigger(
      database,
      row.repo,
      h,
      row.forge.type,
      {
        event,
        change,
        previous,
        conversation,
        commandAt,
        ...session.version,
      },
    );
    if ("retry" in accepted) return 409;
    if (accepted.closedReplyId)
      return explainClosedCommand(api, event, accepted.closedReplyId);
    const reviewId = "reviewId" in accepted && accepted.reviewId;
    if (reviewId) {
      log.info({ deliveryId: delivery, reviewId }, "comment review queued");
      stage = "acknowledge-comment";
      await processInteraction(database, reviewId);
    }
    return outcome(202, "accepted");
  }

  try {
    if (normalizedEvent.kind === "push") return await handlePush();
    // Competing webhook observations race only in short SQL transactions. Refetch the
    // authoritative PR after a conflict instead of accepting an older snapshot.
    for (let attempt = 0; attempt < 4; attempt++) {
      const [received] = await database.db
        .select()
        .from(webhookDeliveries)
        .where(triggerDelivery(h.id, normalizedEvent));
      if (received && !received.pendingAction)
        return outcome(202, "duplicate-delivery");
      if (
        received?.pendingAction &&
        received.pendingAction !== "review-history"
      ) {
        if (
          normalizedEvent.kind !== "comment" ||
          received.closedCommandId !==
            `${normalizedEvent.number}:${normalizedEvent.commentId}`
        )
          return outcome(202, "duplicate-delivery");
        return await handleComment(received.id);
      }
      const status =
        normalizedEvent.kind === "comment"
          ? await handleComment()
          : outcome(
              ...(await handlePullRequest(
                database,
                row,
                normalizedEvent,
                (next) => {
                  stage = next;
                },
              )),
            );
      if (status !== 409) return status;
    }
    return outcome(503, "pull-request-changed-during-admission");
  } catch (error) {
    log.error(
      {
        deliveryId: delivery,
        stage,
        reason: webhookErrorReason(error),
      },
      "webhook processing failed",
    );
    await database.db
      .update(repositoryWebhooks)
      .set({ lastDelivery: "failed", lastDeliveryAt: new Date() })
      .where(eq(repositoryWebhooks.id, h.id));
    return 503;
  }
}

// A disabled hook may still own a native verdict whose response or final checkpoint was lost.
const nativeRecoveryPending = sql<boolean>`coalesce(${dispatchOutbox.publication}->>'mode' = 'review' and (
  ${dispatchOutbox.publication} ? 'remoteId'
  or (${dispatchOutbox.publication}->>'writing' = 'true' and not (${dispatchOutbox.publication} ? 'providerProgress'))
  or ${dispatchOutbox.publication} #>> '{providerProgress,bulk,writing}' = 'true'
  or ${dispatchOutbox.publication} #>> '{providerProgress,bulk,submitted}' = 'true'
  or ${dispatchOutbox.publication} #>> '{providerProgress,bulk,id}' is not null
), false)`;

/** Resolve an active review's owning repository and outbox key before taking its interaction lock. */
async function interactionScope(database: Database, reviewId: string) {
  const [scope] = await database.db
    .select({
      repositoryId: repositories.publicId,
      reviewId: reviews.id,
    })
    .from(reviewTriggers)
    .innerJoin(reviews, eq(reviewTriggers.reviewId, reviews.id))
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .where(
      and(eq(reviews.publicId, reviewId), eq(repositories.status, "active")),
    );
  return scope;
}

const abandonedGitlabBulk =
  "An operator stopped reconciliation of an unconfirmed GitLab bulk publication. The verdict was not resent.";

/**
 * Stop retries for one ambiguous GitLab bulk at an operator's request. Reconcile
 * visible submissions normally; otherwise remove only this run's owned drafts.
 * Preserve the bulk fence across every provider and database failure.
 */
export async function abandonGitlabPublication(
  database: Database,
  reviewId: string,
  originalBotId?: string,
) {
  publicIdSchema("review").parse(reviewId);
  const scope = await interactionScope(database, reviewId);
  if (!scope) return "ineligible";
  const result = await interactionLock(
    database,
    `repository:${scope.repositoryId}`,
    async (client) => {
      const row = await context(database, scope.repositoryId);
      if (
        row.repo.status !== "active" ||
        row.forge.type !== "gitlab" ||
        !row.hook.botId
      )
        return "ineligible";
      const entry = await publicationView(database, reviewId);
      const publication = entry?.publication;
      if (
        publication?.state === "unconfirmed" &&
        publication.error === abandonedGitlabBulk
      )
        return "abandoned";
      const operations = publication?.providerProgress;
      const bulk = operations?.bulk;
      if (
        !entry ||
        !publication?.reviewPayload ||
        publication.mode !== "review" ||
        !["publishing", "uncertain", "failed"].includes(publication.state) ||
        !bulk?.writing ||
        bulk.submitted ||
        bulk.id ||
        bulk.confirmation ||
        publication.remoteId ||
        operations?.summary ||
        publication.inlineIds?.length
      )
        return "ineligible";
      const api = await adapter(database, row, 30000, true);
      const bot = await api.identity();
      if (
        bot.id !== row.hook.botId ||
        (bulk.botId && bot.id !== bulk.botId) ||
        (originalBotId !== undefined && bot.id !== originalBotId) ||
        !api.discardPendingReview
      )
        return "ineligible";
      const number = entry.change.number;
      const marker = `<!-- razbor-gitlab:${reviewId}:${entry.change.headSha}:${publication.reviewPayload.event}:`;
      /** A visible summary takes precedence over abandonment, including one that appears during draft cleanup. */
      const hasSummary = async () =>
        (await api.comments(number, { complete: true })).some(
          (note) =>
            note.user.id === bot.id &&
            ["pending", "complete", "unconfirmed"].some((state) =>
              note.body.endsWith(`${marker}${state} -->`),
            ),
        );
      if (await hasSummary()) return "submitted";
      // Legacy checkpoints did not record the owner. A rotated token cannot see
      // that owner's drafts, so an empty list cannot establish their absence.
      if (!bulk.botId && !originalBotId) return "ineligible";
      const db = drizzle(client);
      /** Retain the original bulk fence while recording draft IDs recovered during cleanup. */
      const save = async (value: Publication) => {
        await db
          .update(dispatchOutbox)
          .set({ publication: value })
          .where(eq(dispatchOutbox.reviewId, scope.reviewId));
      };
      const drafts = { ...operations };
      delete drafts.bulk;
      await api.discardPendingReview(number, reviewId, drafts, async (next) => {
        publication.providerProgress = { ...next, bulk };
        await save(publication);
      });
      if (await hasSummary()) return "submitted";
      await save({
        ...publication,
        state: "unconfirmed",
        writing: false,
        error: abandonedGitlabBulk,
      });
      return "abandoned";
    },
  );
  return result ?? "busy";
}

/**
 * Serialize one review's acknowledgement or final publication, reconciling
 * remote markers before writes and preserving uncertain outcomes for later
 * recovery. Provider credential failures defer only this review's interaction.
 */
export async function processInteraction(database: Database, reviewId: string) {
  const scope = await interactionScope(database, reviewId);
  if (!scope) return;
  const lock = `repository:${scope.repositoryId}`;
  await interactionLock(database, lock, async (lockClient) => {
    const interactionDb = drizzle(lockClient);
    const [entry] = await database.db
      .select({
        review: reviews,
        trigger: reviewTriggers,
        outbox: dispatchOutbox,
        recoverNative: nativeRecoveryPending,
        repositoryId: repositories.publicId,
        generation: pullRequests.triggerGeneration,
      })
      .from(reviews)
      .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
      .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .leftJoin(
        pullRequests,
        and(
          eq(pullRequests.repositoryId, reviews.repositoryId),
          sql`${pullRequests.number}::text = ${reviewTriggers.change}->>'number'`,
        ),
      )
      .where(eq(reviews.publicId, reviewId));
    if (!entry) return;
    const { review, trigger, outbox } = entry;
    if (
      outbox.acknowledgedAt &&
      (review.status === "queued" ||
        review.status === "running" ||
        ["published", "stale", "unconfirmed"].includes(
          outbox.publication?.state ?? "",
        ))
    )
      return;
    const row = await context(database, entry.repositoryId);
    if (
      row.repo.status !== "active" ||
      (!row.hook.enabled && !entry.recoverNative)
    )
      return;
    if (!row.hook.botId) return;
    const bot = row.hook.botId;
    let metadata: RepositoryMetadata | undefined;
    /** Read the PR session and owning policy together for the saved review. */
    function sessionQuery(db: Pick<Database["db"], "select">) {
      return db
        .select({
          pr: pullRequests,
          mode: repositories.reviewTriggerMode,
          senders: repositoryWebhooks.senders,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .innerJoin(
          repositoryWebhooks,
          eq(repositoryWebhooks.repositoryId, repositories.id),
        )
        .where(
          and(
            eq(pullRequests.repositoryId, review.repositoryId),
            eq(pullRequests.number, trigger.change.number),
            eq(repositories.status, "active"),
          ),
        );
    }

    /** An opt-in from a previous open session cannot authorize publication on a reopened PR. */
    function sessionAllowsReview(
      session: Awaited<ReturnType<typeof sessionQuery>>[number] | undefined,
    ) {
      return (
        !!session &&
        session.pr.state === "open" &&
        session.pr.draft === false &&
        session.pr.headSha === review.headSha &&
        session.pr.baseSha === trigger.change.baseSha &&
        (session.pr.mergeBase === null ||
          session.pr.mergeBase === review.baseSha) &&
        (session.pr.startSha === null ||
          session.pr.startSha === trigger.change.startSha) &&
        ((session.mode === "automatic" &&
          allowsAutomaticAuthor(
            metadata?.visibility,
            session.pr.author,
            session.senders,
          )) ||
          (session.mode === "opt_in_continuous" &&
            !!session.pr.continuousReviewSince))
      );
    }

    /**
     * Persist acknowledgement or publication progress and defer the next
     * interaction retry by thirty seconds.
     */
    const update = async (
      values: Partial<typeof dispatchOutbox.$inferInsert>,
    ) => {
      const next = {
        ...values,
        interactionAfter: new Date(Date.now() + 30000),
      };
      if (
        values.publication?.state === "stale" &&
        review.status === "completed"
      ) {
        // A ready event can commit while the stale provider write is in flight.
        // Serialize the terminal write with admission's PR -> outbox lock order.
        await database.transaction(async (tx) => {
          const [session] = await sessionQuery(tx).for("update", {
            of: pullRequests,
          });
          await tx
            .update(dispatchOutbox)
            .set(next)
            .where(eq(dispatchOutbox.id, outbox.id));
          if (
            session &&
            session.pr.triggerGeneration >
              (values.publication?.staleGeneration ?? entry.generation ?? 0) &&
            sessionAllowsReview(session)
          )
            await rearmStalePublication(
              tx,
              review.id,
              session.pr.triggerGeneration,
            );
        });
        return;
      }
      // The final GitLab checkpoint can run under the submission lock. Persist it
      // on the same connection before sending the POST.
      await interactionDb
        .update(dispatchOutbox)
        .set(next)
        .where(eq(dispatchOutbox.id, outbox.id));
    };
    let api: Forge;
    try {
      ({ api, metadata } = await openAdapter(
        database,
        row,
        outbox.acknowledgedAt ? 30000 : 6000,
        true,
      ));
    } catch (error) {
      logger.warn(
        { reviewId, reason: webhookErrorReason(error) },
        "review provider credentials unavailable; retry pending",
      );
      // No provider write was attempted: retain every reconciliation marker
      // and uncertain-write flag while deferring this entry's next attempt.
      const message = "Provider credentials unavailable; retry pending";
      await update(
        outbox.acknowledgedAt
          ? {
              publication: {
                ...(outbox.publication ?? { state: "pending" }),
                error: message,
              },
            }
          : {
              acknowledgement: {
                ...outbox.acknowledgement,
                error: message,
              },
            },
      );
      return;
    }
    const marker = `<!-- razbor:${review.publicId}:`;
    /**
     * Prefer an idempotent reaction, falling back to a marked comment only
     * when unsupported; reconcile uncertain writes before enabling dispatch.
     */
    async function acknowledge() {
      if (!trigger.commentId) {
        await update({ acknowledgedAt: new Date() });
        return;
      }
      try {
        if (!outbox.acknowledgement?.writing) {
          try {
            await api.react(trigger.commentId, bot, trigger.change.number);
            await update({ acknowledgedAt: new Date(), acknowledgement: {} });
            logger.info(
              { reviewId },
              "review comment acknowledged by reaction",
            );
            return;
          } catch (error) {
            if (
              !(error instanceof ForgeOperationError) ||
              error.uncertain ||
              !["unsupported", "permission"].includes(error.reason)
            )
              throw error;
            if (!review.source.conversation) {
              // The optional status now provides the visible fallback. Keep
              // execution available when the forge disallows reactions.
              await update({ acknowledgedAt: new Date(), acknowledgement: {} });
              return;
            }
          }
        }
        const existing = (await api.comments(trigger.change.number)).find(
          (c) => c.user.id === bot && c.body.includes(`${marker}queued -->`),
        );
        if (existing) {
          await update({
            acknowledgedAt: new Date(),
            acknowledgement: { remoteId: existing.id },
          });
          return;
        }
        if (outbox.acknowledgement?.writing) {
          await update({
            acknowledgement: {
              writing: true,
              error:
                "Acknowledgement outcome uncertain; reconciliation pending",
            },
          });
          return;
        }
        await update({ acknowledgement: { writing: true } });
        try {
          const remoteId = await api.postComment(
            trigger.change.number,
            `${review.source.conversation ? "Reply queued. I’ll respond in the review thread." : "Review queued. I’ll post the results here."}\n\n${marker}queued -->`,
          );
          await update({
            acknowledgedAt: new Date(),
            acknowledgement: { remoteId },
          });
          logger.info({ reviewId }, "review comment acknowledged by reply");
        } catch (error) {
          logger.warn(
            {
              reviewId,
              reason:
                error instanceof ForgeOperationError
                  ? error.reason
                  : "unavailable",
            },
            "review acknowledgement reply failed",
          );
          await update({
            acknowledgement: {
              writing:
                !(error instanceof ForgeOperationError) || error.uncertain,
              error: "Acknowledgement failed",
            },
          });
        }
      } catch (error) {
        logger.warn(
          {
            reviewId,
            reason:
              error instanceof ForgeOperationError
                ? error.reason
                : "unavailable",
          },
          "review acknowledgement failed; retry pending",
        );
        await update({
          acknowledgement: {
            ...outbox.acknowledgement,
            error: "Acknowledgement failed; retry pending",
          },
        });
      }
    }

    if (!outbox.acknowledgedAt) {
      await acknowledge();
      return;
    }
    let progress: Publication = outbox.publication ?? { state: "pending" };
    /** Check the provider's revisions and, for automatic work, the current session after each remote read. */
    async function currentRevision(change: ForgeChange) {
      if (
        change.headSha !== review.headSha ||
        change.baseSha !== trigger.change.baseSha ||
        change.mergeBase !== review.baseSha ||
        change.startSha !== trigger.change.startSha
      )
        return false;
      if (trigger.origin !== "automatic" && !progress.rearmed) return true;
      if (change.draft !== false) return false;
      const [session] = await sessionQuery(database.db);
      return sessionAllowsReview(session);
    }
    /**
     * Publish a result into its verified original review thread, reconciling
     * marked replies and annotating answers whose pull request revisions
     * changed.
     */
    async function publishConversation(
      conversation: NonNullable<typeof review.source.conversation>,
    ) {
      const target = conversation.target;
      const comments = await api.reviewComments(
        trigger.change.number,
        target.reviewId,
      );
      const existing = comments.find(
        (c) =>
          c.user?.id === bot &&
          (target.threadId
            ? c.threadId === target.threadId
            : c.path === target.path &&
              c.lineStart === target.lineStart &&
              c.lineEnd === target.lineEnd) &&
          c.body.includes(`${marker}result -->`),
      );
      if (existing) {
        await update({
          publication: {
            ...progress,
            state: "published",
            mode: "comment",
            remoteId: existing.id,
            writing: false,
          },
        });
        return;
      }
      if (progress.writing) {
        await update({
          publication: {
            ...progress,
            state: "uncertain",
            error:
              "Reply outcome uncertain; reconciliation pending. No duplicate write will be attempted.",
          },
        });
        return;
      }
      const parent = comments.some(
        (c) =>
          c.id === target.commentId &&
          c.user?.id === bot &&
          (target.threadId
            ? c.threadId === target.threadId
            : c.path === target.path &&
              c.lineStart === target.lineStart &&
              c.lineEnd === target.lineEnd),
      );
      if (!parent) throw new Error("Original review thread unavailable");
      let body: string;
      if (review.status === "failed") {
        body = `I couldn’t complete this reply. Check run ${review.publicId} in razbor, then reply again to retry.`;
      } else {
        validateFindingChecks(review.result!, undefined, true);
        body = forgeMarkdown(review.result!.summary, target.path);
        if (!body.trim()) throw new Error("Empty conversational reply");
        const current = await api.change(trigger.change.number);
        if (!(await currentRevision(current)))
          body = `This answer uses commit \`${review.headSha}\`; the PR has changed since this reply started.\n\n${body}`;
      }
      progress = {
        ...progress,
        state: "publishing",
        mode: "comment",
        writing: true,
        error: undefined,
      };
      await update({ publication: progress });
      const remoteId = await api.replyToReview(
        trigger.change.number,
        target.reviewId,
        {
          path: target.path,
          lineStart: target.lineStart,
          lineEnd: target.lineEnd,
          commentId: target.commentId,
          threadId: target.threadId,
          body: `${body}\n\n${marker}result -->`,
        },
      );
      await update({
        publication: {
          ...progress,
          state: "published",
          remoteId,
          writing: false,
        },
      });
    }

    /** Report whether a later completed publication supersedes this run. */
    async function hasNewerPublishedReview(): Promise<boolean> {
      // A late older run must not supersede a newer review decision, even on the same SHA.
      const [newer] = await database.db
        .select({ id: reviews.id })
        .from(reviews)
        .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
        .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
        .where(
          and(
            eq(reviewTriggers.repositoryId, trigger.repositoryId),
            sql`${reviewTriggers.change}->>'number' = ${String(trigger.change.number)}`,
            sql`(${reviews.createdAt}, ${reviews.publicId}) > (select created_at, public_id from reviews where id = ${review.id})`,
            progress.rearmed
              ? and(
                  eq(reviews.headSha, review.headSha),
                  eq(reviews.baseSha, review.baseSha),
                  sql`${reviewTriggers.change}->>'baseSha' = ${trigger.change.baseSha}
                and ${reviewTriggers.change}->>'startSha' is not distinct from ${trigger.change.startSha ?? null}`,
                )
              : undefined,
            sql`${reviews.source}->'conversation' IS NULL`,
            sql`${dispatchOutbox.publication}->>'state' = 'published'`,
          ),
        )
        .limit(1);
      return !!newer;
    }

    /**
     * Confirm resolved bot findings in their original threads, then resolve
     * native threads where supported, after rechecking the reviewed revision.
     */
    async function finishReviewPublication() {
      const payload = progress.reviewPayload;
      if (!row.hook.enabled) {
        await update({
          publication: {
            ...progress,
            state: "published",
            writing: false,
            error: undefined,
            limitations: [
              ...new Set([
                ...(progress.limitations ?? []),
                "Recovered the submitted review while the webhook was disabled. Additional summary and thread updates were skipped.",
              ]),
            ],
          },
        });
        return;
      }
      if (payload?.recapReviewId) {
        const current = await api.change(trigger.change.number);
        if (
          (await hasNewerPublishedReview()) ||
          !(await currentRevision(current))
        ) {
          progress = {
            ...progress,
            state: "stale",
            stale: true,
            writing: false,
            error: undefined,
            limitations: [
              ...(progress.limitations ?? []),
              "Summary update skipped because the revisions changed or a newer review was published.",
            ],
          };
          await update({ publication: progress });
          return;
        }
        // The target and body were frozen before the first provider write.
        // Editing the same body is replayable even after a lost response.
        await api.editReview(
          trigger.change.number,
          payload.recapReviewId,
          payload.body,
        );
      }
      if (
        review.status === "completed" &&
        !progress.stale &&
        !progress.rearmed
      ) {
        const previous = review.source.previousFindings ?? [];
        validateFindingChecks(review.result!, previous);
        const resolved = new Map(
          (review.result!.findingChecks ?? [])
            .filter((check) => check.status === "resolved")
            .map((check) => [check.id, check]),
        );
        if (resolved.size) {
          const current = await previousFindings(
            database,
            trigger.repositoryId,
            trigger.change.number,
            bot,
            api,
            review.publicId,
          );
          for (const finding of current.findings) {
            if (
              !finding.threadId ||
              !resolved.has(finding.id) ||
              !previous.some(
                (old) =>
                  old.id === finding.id &&
                  old.reviewId === finding.reviewId &&
                  findingKey(old.finding) === findingKey(finding.finding),
              )
            )
              continue;
            const target = current.targets.get(finding.id);
            if (!target) continue;
            /** Verify current revisions before each reply or native resolution. */
            async function canUpdateThread() {
              if (await hasNewerPublishedReview()) {
                const note =
                  "Thread update skipped because a newer review was published.";
                progress.limitations = [
                  ...new Set([...(progress.limitations ?? []), note]),
                ];
                return false;
              }
              const latest = await api.change(trigger.change.number);
              if (!(await currentRevision(latest))) {
                const note =
                  "Thread update skipped because the change revisions advanced after publication.";
                progress.limitations = [
                  ...new Set([...(progress.limitations ?? []), note]),
                ];
                return false;
              }
              return true;
            }
            // Keep one confirmation per original finding, including providers
            // that cannot resolve its thread and will return it on later reviews.
            const fixedMarker = `<!-- razbor:${finding.reviewId}:${findingKey(finding.finding)}:fixed -->`;
            const operationKey = `fixed:${finding.id}`;
            const replies = await api.reviewComments(
              trigger.change.number,
              target.reviewId,
            );
            const existing = replies.find(
              (comment) =>
                comment.user?.id === bot &&
                comment.threadId === finding.threadId &&
                comment.body.includes(fixedMarker),
            );
            const operation = progress.providerProgress?.[operationKey];
            if (!existing && (operation?.writing || operation?.id))
              throw new ForgeOperationError("unavailable", true);
            let replyId = existing?.id;
            if (!replyId) {
              if (!(await canUpdateThread())) break;
              progress.providerProgress = {
                ...progress.providerProgress,
                [operationKey]: { writing: true },
              };
              await update({ publication: progress });
              try {
                replyId = await api.replyToReview(
                  trigger.change.number,
                  target.reviewId,
                  {
                    path: target.comment.path,
                    lineStart:
                      target.comment.lineStart ?? finding.finding.lineStart,
                    lineEnd: target.comment.lineEnd ?? finding.finding.lineEnd,
                    commentId: target.comment.id,
                    threadId: finding.threadId,
                    body: `✅ Re-review confirmed this finding is resolved at commit \`${review.headSha}\`.\n\n${forgeMarkdown(resolved.get(finding.id)!.evidence, finding.finding.path)}\n\n${fixedMarker}`,
                  },
                );
              } catch (error) {
                if (error instanceof ForgeOperationError && !error.uncertain) {
                  progress.providerProgress[operationKey] = { writing: false };
                  await update({ publication: progress });
                }
                throw error;
              }
            }
            progress.providerProgress = {
              ...progress.providerProgress,
              [operationKey]: { id: replyId, writing: false },
            };
            await update({ publication: progress });
            if (api.capabilities.resolveThreads) {
              if (!(await canUpdateThread())) break;
              await api.resolveThread(trigger.change.number, finding.threadId);
            }
          }
        }
      }
      progress = {
        ...progress,
        state: "published",
        writing: false,
        error: undefined,
      };
      await update({ publication: progress });
    }

    /** A sent or possibly sent GitLab bulk must use its frozen payload exclusively for recovery. */
    function hasGitlabSubmission() {
      const bulk = progress.providerProgress?.bulk;
      return (
        api.type === "gitlab" &&
        !!(bulk?.writing || bulk?.submitted || bulk?.id)
      );
    }

    /**
     * Recover bot-owned marked provider writes and stop duplicate publication
     * while a prior write's outcome remains uncertain.
     */
    async function reconcilePublication() {
      if (progress.mode === "recap" && progress.reviewPayload?.recapReviewId) {
        await finishReviewPublication();
        return true;
      }
      const remoteReviews = await api.reviews(trigger.change.number);
      const existingReview = await publishedReview(
        api,
        trigger.change.number,
        remoteReviews,
        bot,
        review.headSha,
        review.publicId,
        progress,
      );
      if (existingReview) {
        progress = {
          ...progress,
          writing: false,
          remoteId: existingReview.id,
          mode: "review",
        };
        const inlineIds = (
          await api.reviewComments(trigger.change.number, existingReview.id)
        )
          .filter((c) => c.body.includes(marker))
          .map((c) => c.id);
        progress = { ...progress, inlineIds };
        await update({ publication: progress });
        await finishReviewPublication();
        return true;
      }
      if (
        progress.mode === "review" &&
        progress.remoteId &&
        !hasGitlabSubmission()
      ) {
        // A rotated bot or a temporarily incomplete listing cannot authorize resubmitting a known native review.
        await update({
          publication: {
            ...progress,
            state: "uncertain",
            error:
              "The saved native review is not visible to this bot. Reconciliation is pending.",
          },
        });
        return true;
      }
      const existingComment =
        progress.mode !== "review"
          ? (await api.comments(trigger.change.number)).find(
              (c) =>
                c.user.id === bot &&
                c.id !== progress.staleNoticeId &&
                c.body.includes(`${marker}result -->`),
            )
          : undefined;
      if (existingComment) {
        await update({
          publication: {
            ...progress,
            state: progress.stale ? "stale" : "published",
            writing: false,
            remoteId: existingComment.id,
          },
        });
        return true;
      }
      if (
        progress.writing &&
        !(
          api.type === "gitlab" &&
          progress.mode === "review" &&
          progress.providerProgress
        )
      ) {
        await update({
          publication: {
            ...progress,
            state: "uncertain",
            error:
              "Provider write outcome uncertain; reconciliation pending. No duplicate write will be attempted.",
          },
        });
        return true;
      }
      return false;
    }

    /**
     * Publish a revision-checked native review and recap with duplicate
     * findings suppressed; append a status comment instead when the result is
     * stale or failed.
     */
    async function publishReview() {
      if (hasGitlabSubmission()) {
        // A submitted GitLab verdict may already be visible. Recover its frozen
        // notes and summary before a fresh change observation can retire the run.
        if (!progress.reviewPayload)
          throw new ForgeOperationError("unavailable", true);
        await submitNativeReview(progress.reviewPayload);
        return;
      }
      if (!row.hook.enabled) {
        // GitLab journals the bulk operation before the POST. Without that checkpoint,
        // a pending GitLab payload can wait safely until the hook is enabled again.
        await update({ publication: { ...progress, writing: false } });
        return;
      }
      const newer = await hasNewerPublishedReview();
      const change = await api.change(trigger.change.number);
      const stale = !!newer || !(await currentRevision(change));
      if (stale || review.status === "failed") {
        if (
          stale &&
          progress.staleNoticeId &&
          !progress.reviewPayload &&
          !progress.providerProgress
        ) {
          await update({
            publication: {
              ...progress,
              mode: "comment",
              remoteId: progress.staleNoticeId,
              state: "stale",
              stale: true,
              staleGeneration: entry.generation ?? 0,
            },
          });
          return;
        }
        if (progress.providerProgress && api.discardPendingReview)
          await api.discardPendingReview(
            trigger.change.number,
            review.publicId,
            progress.providerProgress,
            saveProviderProgress,
          );
        const app =
          row.hook.mode === "github-app"
            ? await getRepositoryGithubApp(database, row.repo.id)
            : undefined;
        if (row.hook.mode === "github-app" && !app)
          throw new Error("GitHub App connection unavailable");
        const body = stale
          ? `Review of \`${review.headSha}\` is stale because the pull request changed or a newer review was published.`
          : `Review of \`${review.headSha}\` failed. No results were published. Check review ${review.publicId} in razbor, then request a new review when resolved.`;
        progress = {
          ...progress,
          state: "publishing",
          mode: "comment",
          stale,
          staleGeneration: stale ? (entry.generation ?? 0) : undefined,
          providerProgress: undefined,
          reviewPayload: undefined,
          writing: true,
          error: undefined,
        };
        await update({ publication: progress });
        const remoteId = await api.postComment(
          trigger.change.number,
          `${body}\n\n${marker}result -->`,
        );
        await update({
          publication: {
            ...progress,
            state: stale ? "stale" : "published",
            remoteId,
            writing: false,
          },
        });
        return;
      }
      let payload = progress.reviewPayload;
      // Once a provider write begins, later history must not change draft
      // indices, recap text or verdict during recovery of the same run.
      if (!payload) {
        const previous = review.source.previousFindings ?? [];
        validateFindingChecks(review.result!, previous);
        const checks = new Map(
          (review.result!.findingChecks ?? []).map((c) => [c.id, c]),
        );
        const {
          findings: currentPrevious,
          openOwners,
          recapReviewId,
        } = await previousFindings(
          database,
          trigger.repositoryId,
          trigger.change.number,
          bot,
          api,
          review.publicId,
        );
        // A resolved original cannot represent a recurrence. Publish that
        // finding under this review's own revision and identity.
        const openFindingOwners: Record<string, string> = {};
        for (const finding of review.result!.findings) {
          const key = findingKey(finding);
          const owner = openOwners.get(key);
          if (owner) openFindingOwners[key] = owner;
        }
        const prepared = preparePublication(
          {
            ...review.result!,
            findings: review.result!.findings.filter(
              (f) => !openFindingOwners[findingKey(f)],
            ),
          },
          await api.diff(trigger.change.number),
          review.publicId,
        );
        // Preserve historical content; native thread resolution happens only
        // after this run's complete publication and a fresh revision check.
        const outstanding = currentPrevious.flatMap((old) => {
          const assessed = previous.some(
            (p) =>
              p.id === old.id &&
              p.reviewId === old.reviewId &&
              findingKey(p.finding) === findingKey(old.finding),
          );
          const status = assessed ? checks.get(old.id)?.status : undefined;
          return status === "resolved"
            ? []
            : [
                {
                  title: old.finding.title,
                  severity: old.finding.severity,
                  finding: old.finding,
                  originalHead: old.originalHead,
                  status:
                    status === "open"
                      ? ("open" as const)
                      : ("uncertain" as const),
                },
              ];
        });
        const needsChanges = !!(prepared.findings.length || outstanding.length);
        // A replay may follow intervening reviews and human replies. Publish a
        // new revision-bound summary without editing their recaps or resolving threads.
        const target =
          needsChanges && !progress.rearmed ? recapReviewId : undefined;
        const inlineOnly = api.type === "forgejo" && !!target;
        const event =
          needsChanges && !inlineOnly ? "REQUEST_CHANGES" : "COMMENT";
        const body = `${renderReview(
          { ...review.result!, findings: prepared.findings },
          review.headSha,
          {
            author: change.author,
            previousFindings: outstanding,
            limitations: prepared.limitations,
            repositoryUrl: row.repo.observed?.webUrl,
            forgeType: row.forge.type,
            anchoredFindings: prepared.comments.map((c) => ({
              path: c.path,
              lineStart: c.lineStart,
              lineEnd: c.lineEnd,
            })),
          },
        )}\n\n${marker}${target ? "recap" : "result"} -->`;
        payload = {
          body,
          comments: prepared.comments,
          event,
          recapReviewId: target,
        };
        progress = {
          ...progress,
          mode:
            target &&
            !(inlineOnly ? prepared.comments.length : prepared.findings.length)
              ? "recap"
              : "review",
          limitations: prepared.limitations,
          outstandingFindings: outstanding.length,
          openFindingOwners,
        };
      }
      const latest = await api.change(trigger.change.number);
      if (!(await currentRevision(latest)))
        throw new Error("Revision changed while preparing publication");
      // A check-only repeat needs only a replayable edit. New findings retain
      // their own revision-bound review record without duplicating the recap.
      const recapOnly = progress.mode === "recap";
      progress = {
        ...progress,
        state: "publishing",
        stale: false,
        mode: recapOnly ? "recap" : "review",
        writing: !recapOnly,
        ...(api.type === "gitlab" &&
          !recapOnly && { providerProgress: progress.providerProgress ?? {} }),
        reviewPayload: payload,
        error: undefined,
      };
      await update({ publication: progress });
      if (recapOnly) {
        progress = { ...progress, remoteId: payload.recapReviewId };
        await update({ publication: progress });
        await finishReviewPublication();
        return;
      }
      await submitNativeReview(payload);
    }

    /** Order the final native POST against committed trigger changes, without opening a transaction for provider I/O. */
    async function submitUnderPolicy<T>(write: () => Promise<T>): Promise<T> {
      const key = reviewSubmissionLock(trigger.repositoryId);
      let started = false;
      try {
        if ((await api.identity()).id !== bot)
          throw new ForgeOperationError("permission");
        const lock = await lockClient.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(748322, hashtext($1)) as locked",
          [key],
        );
        if (!lock.rows[0].locked) throw new ForgeOperationError("unavailable");
        try {
          const [hook] = await interactionDb
            .select({ enabled: repositoryWebhooks.enabled })
            .from(repositoryWebhooks)
            .innerJoin(
              repositories,
              eq(repositories.id, repositoryWebhooks.repositoryId),
            )
            .where(
              and(
                eq(repositoryWebhooks.id, trigger.webhookId),
                eq(repositoryWebhooks.botId, bot),
                eq(repositories.id, trigger.repositoryId),
                eq(repositories.status, "active"),
              ),
            );
          if (!hook?.enabled) throw new ForgeOperationError("permission");
          if (trigger.origin === "automatic" || progress.rearmed) {
            const [session] = await sessionQuery(interactionDb);
            if (!sessionAllowsReview(session))
              throw new ForgeOperationError("invalid-response");
          }
          started = true;
          return await write();
        } finally {
          await lockClient.query(
            "select pg_advisory_unlock(748322, hashtext($1))",
            [key],
          );
        }
      } catch (error) {
        if (error instanceof ForgeOperationError) throw error;
        throw new ForgeOperationError("unavailable", started);
      }
    }

    /** Persist each provider operation before sending it and after confirming its identity or submission. */
    async function saveProviderProgress(
      providerProgress: NonNullable<Publication["providerProgress"]>,
    ) {
      progress = {
        ...progress,
        providerProgress: structuredClone(providerProgress),
      };
      await update({ publication: progress });
    }

    /** Submit or reconcile the frozen provider payload, then record its remote review and inline identities. */
    async function submitNativeReview(
      payload: NonNullable<Publication["reviewPayload"]>,
    ) {
      const remoteId = await api.postReview(
        trigger.change.number,
        review.headSha,
        payload.recapReviewId ? `${marker}result -->` : payload.body,
        payload.comments,
        payload.event,
        {
          progress: progress.providerProgress ?? {},
          revision: trigger.change,
          unconfirmedBody: payload.recapReviewId ? payload.body : undefined,
          requireReady: trigger.origin === "automatic" || !!progress.rearmed,
          submit: submitUnderPolicy,
          save: saveProviderProgress,
        },
      );
      progress = { ...progress, remoteId, writing: false };
      await update({ publication: progress });
      progress.inlineIds = (
        await api.reviewComments(trigger.change.number, remoteId)
      )
        .filter((c) => c.body.includes(marker))
        .map((c) => c.id);
      const confirmation = progress.providerProgress?.bulk?.confirmation;
      if (
        api.type === "gitlab" &&
        confirmation &&
        confirmation !== "confirmed"
      ) {
        await update({
          publication: {
            ...progress,
            state: "unconfirmed",
            error:
              "GitLab published the review notes, but the verdict on the reviewed revision could not be confirmed.",
          },
        });
        return;
      }
      await finishReviewPublication();
    }

    try {
      const conversation = review.source.conversation;
      if (conversation) {
        await publishConversation(conversation);
        return;
      }
      if (await reconcilePublication()) return;
      await publishReview();
    } catch (error) {
      if (
        error instanceof ForgeOperationError &&
        error.reason === "change-closed" &&
        !progress.writing
      ) {
        if (hasGitlabSubmission() && !progress.remoteId) {
          await update({
            publication: {
              ...progress,
              state: "uncertain",
              error: "GitLab bulk submission pending reconciliation",
            },
          });
          return;
        }
        const beforeGitlabSubmission =
          api.type === "gitlab" &&
          progress.mode === "review" &&
          !progress.remoteId &&
          !progress.inlineIds &&
          !progress.providerProgress?.summary &&
          !hasGitlabSubmission();
        if (
          beforeGitlabSubmission &&
          progress.providerProgress &&
          api.discardPendingReview
        ) {
          try {
            await api.discardPendingReview(
              trigger.change.number,
              review.publicId,
              progress.providerProgress,
              saveProviderProgress,
            );
          } catch {
            await update({
              publication: {
                ...progress,
                state: "failed",
                error: "Closed pull request draft cleanup pending",
              },
            });
            return;
          }
        }
        await update({
          publication: {
            ...progress,
            ...(beforeGitlabSubmission && {
              mode: undefined,
              reviewPayload: undefined,
              providerProgress: undefined,
              staleGeneration: entry.generation ?? 0,
            }),
            state: "stale",
            stale: true,
            writing: false,
            error: "The pull request closed before publication.",
          },
        });
        return;
      }
      const uncertain =
        (entry.recoverNative &&
          api.type !== "gitlab" &&
          progress.mode === "review") ||
        ((progress.writing ||
          Object.entries(progress.providerProgress ?? {}).some(
            ([key, operation]) => key.startsWith("fixed:") && operation.writing,
          )) &&
          (!(error instanceof ForgeOperationError) || error.uncertain));
      await update({
        publication: {
          ...progress,
          state: uncertain ? "uncertain" : "failed",
          writing: uncertain,
          error:
            error instanceof ForgeOperationError
              ? error.message
              : "Publication unavailable; retry pending",
        },
      });
    }
  });
}

/** Identify definitive rejections while verifying a deferred delivery's repository or MR. */
function deferredRejection(stage: string, error: unknown) {
  if (stage === "verify-repository") {
    // openAdapter rejects a changed external repository ID before opening the client.
    if (error instanceof ForgeOperationError && error.reason === "permission")
      return "repository-identity-mismatch";
    if (error instanceof ForgeReadError && error.reason === "invalid-response")
      return "invalid-repository-response";
  }
  if (stage === "read-pull-request" && error instanceof ForgeOperationError) {
    if (error.reason === "invalid-response")
      return "invalid-pull-request-response";
    // A 404 can mask missing access. Only discard requests the provider definitively rejects.
    if ([400, 405, 410, 422].includes(error.status ?? 0))
      return "pull-request-read-rejected";
  }
}

/** Resume one authenticated GitLab delivery, retiring rejected observations and leaving temporary failures due for retry. */
export async function processDeferredOpen(database: Database) {
  const due = sql`${webhookDeliveries.openRetryAfter} <= now()`;
  const [row] = await database.db
    .select({
      receipt: webhookDeliveries,
      hook: repositoryWebhooks,
      repo: repositories,
      forge: forgeInstances,
    })
    .from(webhookDeliveries)
    .innerJoin(
      repositoryWebhooks,
      eq(repositoryWebhooks.id, webhookDeliveries.webhookId),
    )
    .innerJoin(
      repositories,
      eq(repositories.id, repositoryWebhooks.repositoryId),
    )
    .innerJoin(forgeInstances, eq(forgeInstances.id, repositories.forgeId))
    .where(due)
    .orderBy(webhookDeliveries.openRetryAfter)
    .limit(1);
  if (!row?.receipt.pendingOpen) return;
  const { receipt, repo, hook, forge } = row;
  const event = row.receipt.pendingOpen;
  // Claim before provider I/O so the next dispatcher can recover an interrupted read.
  const [claim] = await database.db
    .update(webhookDeliveries)
    .set({ openRetryAfter: sql`now() + interval '30 seconds'` })
    .where(and(eq(webhookDeliveries.id, receipt.id), due))
    .returning({ version: sql<string>`xmin::text` });
  if (!claim) return;
  let reason = "delivery-binding-changed";
  if (
    hook.enabled &&
    hook.updatedAt.toISOString() === event.hookUpdatedAt &&
    repo.status === "active" &&
    forge.type === "gitlab" &&
    repo.externalRepositoryId === event.repositoryId
  ) {
    let stage = "read-session";
    try {
      const [status, outcome] = await handlePullRequest(
        database,
        row,
        event,
        (next) => {
          stage = next;
        },
      );
      // Admission owns successful outcomes; pending diffs, conflicts and outages may retry.
      if (status !== 403) return;
      reason = outcome;
    } catch (error) {
      const rejected = deferredRejection(stage, error);
      if (!rejected) throw error;
      reason = rejected;
    }
  }
  // Preserve the authenticated receipt and session boundary. A redelivery or a
  // newer claim changes xmin and owns the outcome of its own observation.
  const [retired] = await database.db
    .update(webhookDeliveries)
    .set({ pendingAction: null, pendingOpen: null, openRetryAfter: null })
    .where(
      and(
        eq(webhookDeliveries.id, receipt.id),
        sql`xmin = ${claim.version}::xid`,
      ),
    )
    .returning({ id: webhookDeliveries.id });
  if (retired)
    logger.warn(
      { hookId: hook.publicId, deliveryId: receipt.deliveryId, reason },
      "deferred merge request delivery retired",
    );
}

/**
 * Process bounded batches of pending webhook setup and due review
 * acknowledgement or publication work for active repositories.
 */
export async function processInteractions(database: Database) {
  const pendingHooks = await database.db
    .select({ repositoryId: repositories.publicId })
    .from(repositoryWebhooks)
    .innerJoin(
      repositories,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(repositories.status, "active"),
        eq(repositoryWebhooks.setup, "pending"),
      ),
    )
    .limit(5);
  for (const hook of pendingHooks)
    await reconcileWebhook(database, hook.repositoryId);
  const rows = await database.db
    .select({ id: reviews.publicId })
    .from(dispatchOutbox)
    .innerJoin(reviews, eq(dispatchOutbox.reviewId, reviews.id))
    .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .innerJoin(
      repositoryWebhooks,
      eq(repositoryWebhooks.id, reviewTriggers.webhookId),
    )
    .where(
      and(
        eq(repositories.status, "active"),
        sql`(${repositoryWebhooks.enabled} or (${dispatchOutbox.acknowledgedAt} is not null and ${nativeRecoveryPending}))`,
        sql`${repositoryWebhooks.botId} is not null`,
        sql`${dispatchOutbox.interactionAfter} <= now() and (${dispatchOutbox.acknowledgedAt} is null or (${reviews.status} in ('completed','failed') and coalesce(${dispatchOutbox.publication}->>'state','pending') not in ('published','stale','unconfirmed')))`,
      ),
    )
    .orderBy(dispatchOutbox.interactionAfter)
    .limit(10);
  for (const row of rows) await processInteraction(database, row.id);
}

/**
 * Drain due optional comments in retry order. A dedicated repository lock keeps
 * a slow forge away from webhook acceptance, runner claims and final publication.
 */
export async function processStatusComments(database: Database) {
  const due = await database.db
    .select({ reviewId: reviews.publicId, repositoryId: repositories.publicId })
    .from(dispatchOutbox)
    .innerJoin(reviews, eq(reviews.id, dispatchOutbox.reviewId))
    .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .innerJoin(
      repositoryWebhooks,
      eq(repositoryWebhooks.id, reviewTriggers.webhookId),
    )
    .where(
      sql`((${repositories.status} = 'active' and ${repositoryWebhooks.enabled} and ${repositoryWebhooks.botId} is not null and (${statusCommentDue()}))
          or ((${repositories.status} = 'deleting' or (${repositories.status} = 'active' and not ${repositoryWebhooks.enabled}))
            and (${statusCommentDue(true)})))`,
    )
    .orderBy(
      sql`coalesce(${dispatchOutbox.statusAfter}, ${dispatchOutbox.createdAt})`,
      dispatchOutbox.id,
    )
    .limit(10);
  for (const item of due) {
    await interactionLock(database, `status:${item.repositoryId}`, async () => {
      const row = await context(database, item.repositoryId);
      const retire = !row.hook.enabled || row.repo.status === "deleting";
      await syncStatusComment(
        database,
        item.reviewId,
        row.hook.botId,
        () => adapter(database, row, 6000, true),
        retire,
      );
    });
  }
}

/**
 * Read a triggered review's publication and acknowledgement status, returning
 * null for reviews without a provider interaction.
 */
export async function publicationView(database: Database, reviewId: string) {
  const [row] = await database.db
    .select({
      publication: dispatchOutbox.publication,
      acknowledgedAt: dispatchOutbox.acknowledgedAt,
      acknowledgement: dispatchOutbox.acknowledgement,
      statusComment: dispatchOutbox.statusComment,
      origin: reviewTriggers.origin,
      change: reviewTriggers.change,
    })
    .from(reviews)
    .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
    .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
    .where(eq(reviews.publicId, reviewId));
  return row
    ? {
        publication: row.publication,
        acknowledged: !!row.acknowledgedAt,
        statusCommentError: row.statusComment?.error,
        origin: row.origin,
        acknowledgementError: row.acknowledgedAt
          ? undefined
          : row.acknowledgement?.error,
        change: row.change,
      }
    : null;
}
