import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
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
  ForgeOperationError,
} from "@razbor/forge-adapters";

import { snapshotRepositoryAgent } from "@database/src/agents.js";
import { reviewConversation } from "@database/src/conversation.js";
import type { Database } from "@database/src/connection.js";
import { requireContextSession } from "@database/src/contexts.js";
import { getRepositoryGithubApp } from "@database/src/github-apps.js";
import { publicId } from "@database/src/ids.js";
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
import { snapshotRepositoryGuidance } from "@database/src/skills.js";
import { snapshotRepositoryMcpServers } from "@database/src/mcp.js";

export { webhookSettingsSchema } from "@database/src/webhook-settings.js";

/**
 * Run external interaction work under a nonblocking session advisory lock;
 * return undefined if busy and discard the connection if safe cleanup fails.
 */
export async function interactionLock<T>(
  database: Database,
  key: string,
  action: () => Promise<T>,
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
      return await action();
    } finally {
      await client.query("select pg_advisory_unlock(748322,hashtext($1))", [
        key,
      ]);
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
async function adapter(
  database: Database,
  row: Awaited<ReturnType<typeof context>>,
  budgetMs = 20000,
) {
  const f = row.forge;
  const credential = row.repo.apiCredential ?? f.credential;
  const app = await getRepositoryGithubApp(database, row.repo.id);
  if (row.hook.mode === "github-app" && !app)
    throw new Error("GitHub App connection unavailable");
  return createForge(
    {
      type: f.type,
      apiUrl: f.apiUrl,
      webUrl: f.webUrl,
      allowHttp: f.allowHttp,
      token: credential ? await readSecret(credential, database) : undefined,
      ...(app ? { githubAppBot: app.bot } : {}),
    },
    row.repo.observed?.fullPath ?? row.repo.selector!,
    budgetMs,
  );
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
 */
async function publishedReview(
  api: Forge,
  number: number,
  remoteReviews: Awaited<ReturnType<Forge["reviews"]>>,
  bot: string,
  head: string,
  reviewId: string,
  publication: Publication | null | undefined,
) {
  const candidates = remoteReviews.filter(
    (remote) =>
      remote.user.id === bot &&
      remote.commit_id === head &&
      remote.state !== "PENDING",
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
    .orderBy(reviews.createdAt);
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
  let recapReviewId: string | undefined;
  let remoteReviews: Awaited<ReturnType<Forge["reviews"]>> | undefined;

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
          remote.state !== "PENDING",
      )
    ) {
      resolveRecapFindings(review);
      const snapshotKeys = new Set(
        (review.source.previousFindings ?? []).map((old) =>
          findingKey(old.finding),
        ),
      );
      for (const finding of review.result?.findings ?? []) {
        const key = findingKey(finding);
        const newlyPublished =
          !publishedKeys.has(key) && !snapshotKeys.has(key);
        publishedKeys.add(key);
        if (!newlyPublished) continue;
        const id = `recap:${review.publicId}:${key}`;
        recapFindings.set(id, {
          id,
          reviewId: review.publicId,
          finding,
          originalHead: review.headSha,
        });
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
    );
    if (!remote) continue;
    if (publication?.state === "published" && !publication.stale)
      resolveRecapFindings(review);
    // The first native result is the main comment, even when it starts as a
    // short clean-review message. Follow-ups targeting that comment publish
    // only inline findings and must not become another main comment.
    if (
      !recapReviewId &&
      !publication?.stale &&
      publication?.mode === "review" &&
      publication.remoteId === remote.id &&
      !publication.reviewPayload?.recapReviewId
    )
      recapReviewId = remote.id;
    if (!review.result?.findings.length) continue;
    for (const finding of review.result.findings)
      publishedKeys.add(findingKey(finding));
    const comments = await api.reviewComments(number, remote.id);
    for (const comment of comments) {
      if (comment.user?.id !== bot || comment.resolved) continue;
      const finding = review.result.findings.find((f) =>
        comment.body.includes(
          `<!-- razbor:${review.publicId}:${findingKey(f)} -->`,
        ),
      );
      if (finding) {
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
  // Do not silently omit old findings and then congratulate an incomplete review.
  return {
    findings: previousFindingsSchema.parse([
      ...previous,
      ...recapFindings.values(),
    ]),
    targets,
    publishedKeys,
    recapReviewId,
  };
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
      updatedAt: new Date(),
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
      updatedAt: new Date(),
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
          .set({ botId: bot.id })
          .where(eq(repositoryWebhooks.id, row.hook.id));
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
            updatedAt: new Date(),
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
            updatedAt: new Date(),
          })
          .where(eq(repositoryWebhooks.id, row.hook.id));
      }
    });
  });
  return webhookView(database, repositoryId);
}

/**
 * Remove only managed provider hooks during repository deletion. Manual hooks
 * and shared App hooks remain with their owner; return false while locked.
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
   * Greet a newly opened pull request once using a bot-owned marker, then
   * record the delivery as handled.
   */
  async function handlePullRequest() {
    const event =
      normalizedEvent?.kind === "opened" ? normalizedEvent : undefined;
    if (!event) return outcome(204, "not-a-new-pull-request");
    if (event.repositoryId !== row.repo.externalRepositoryId)
      return outcome(403, "repository-not-permitted");
    if (!h.botId) return outcome(503, "bot-identity-unavailable");
    stage = "greet-pull-request";
    const result = await interactionLock(
      database,
      `repository:${row.repo.publicId}`,
      async () => {
        const current = await context(database, row.repo.publicId);
        if (current.repo.status !== "active" || !current.hook.enabled)
          return outcome(404, "repository-unavailable");
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
        const api = await adapter(database, row);
        const marker = `<!-- razbor:${row.repo.publicId}:${event.number}:welcome -->`;
        const existing = (await api.comments(event.number)).some(
          (comment) =>
            comment.user.id === h.botId && comment.body.includes(marker),
        );
        if (!existing) {
          await api.change(event.number);
          await api.postComment(
            event.number,
            `Hey @${event.author}! I'm here to assist you with this pull request. You can request a review by commenting \`${reviewCommandText()}\`.\n\n${marker}`,
          );
        }
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
        return outcome(200, "pull-request-greeted");
      },
    );
    return result ?? outcome(503, "pull-request-greeting-in-progress");
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
      row.repo.selector!,
    );
    return (
      metadata.externalRepositoryId === row.repo.externalRepositoryId &&
      metadata.visibility === "private"
    );
  }

  /** Explain a closed change once per verified command, reconciling bot-owned replies on retries. */
  async function handleClosedComment(
    api: Forge,
    event: Extract<ForgeWebhook, { kind: "comment" }>,
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
        const marker = `<!-- razbor:${row.repo.publicId}:${event.number}:${event.commentId}:closed -->`;
        const existing = (await api.comments(event.number)).some(
          (reply) => reply.user.id === h.botId && reply.body.includes(marker),
        );
        if (!existing)
          await api.postComment(
            event.number,
            `I can only review open pull requests. This pull request is closed or has already been merged, so I haven't started a review. Request a review on an open pull request with \`${reviewCommandText()}\`.\n\n${marker}`,
          );
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
  async function handleComment() {
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
    stage = "check-duplicate";
    const duplicate = await database.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.webhookId, h.id),
          eq(webhookDeliveries.deliveryId, delivery),
        ),
      );
    if (duplicate.length) return outcome(202, "duplicate-delivery");
    if (h.senders.includes("*")) {
      stage = "verify-repository";
      if (!(await wildcardRepositoryIsPrivate()))
        return outcome(403, "wildcard-requires-private-repository");
    }
    const api = await adapter(database, row, 30000);
    stage = "read-pull-request";
    let change: ForgeChange;
    try {
      change = await api.change(event.number);
    } catch (error) {
      if (
        error instanceof ForgeOperationError &&
        error.reason === "change-closed"
      )
        return handleClosedComment(api, event);
      throw error;
    }
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
    if (!conversation) {
      if (!reviewCommand(event.body))
        return outcome(204, "not-a-review-command-or-reply");
      stage = "verify-comment";
      const comment = await api.comment(event.commentId, event.number);
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
    const reviewId = await database.transaction(async (tx) => {
      // Lock the repository before its hook, matching deletion and settings changes.
      const [activeRepository] = await tx
        .select()
        .from(repositories)
        .where(eq(repositories.id, row.repo.id))
        .for("share");
      if (activeRepository?.status !== "active")
        throw new Error("Repository unavailable");
      // Serialize against settings changes and concurrent deliveries for this repository.
      const [current] = await tx
        .select()
        .from(repositoryWebhooks)
        .where(eq(repositoryWebhooks.id, h.id))
        .for("update");
      if (
        !current?.enabled ||
        current.updatedAt.getTime() !== h.updatedAt.getTime()
      )
        throw new Error("Webhook settings changed");
      const received = await tx
        .insert(webhookDeliveries)
        .values({ webhookId: h.id, deliveryId: delivery })
        .onConflictDoNothing()
        .returning();
      if (!received.length) return undefined;
      const [existing] = await tx
        .select({ id: reviews.publicId })
        .from(reviewTriggers)
        .innerJoin(reviews, eq(reviewTriggers.reviewId, reviews.id))
        .where(
          and(
            eq(reviewTriggers.repositoryId, row.repo.id),
            eq(reviewTriggers.commentId, event.commentId),
          ),
        );
      if (existing) return existing.id;
      const git = structuredClone(row.repo.git);
      const remote = git.upstream.split("/")[2];
      git.extra_fetch_refs[remote] = [
        ...(git.extra_fetch_refs[remote] ?? []),
        `refs/pull/${change.number}/head`,
      ];
      const agent = await snapshotRepositoryAgent(tx, activeRepository.agentId);
      const guidance = await snapshotRepositoryGuidance(
        tx,
        activeRepository.guidance,
        activeRepository.contextId,
      );
      const mcpServers = await snapshotRepositoryMcpServers(
        tx,
        activeRepository.id,
      );
      const [review] = await tx
        .insert(reviews)
        .values({
          publicId: publicId("review"),
          repositoryId: row.repo.id,
          baseSha: change.mergeBase,
          headSha: change.headSha,
          source: {
            configKey: row.repo.configKey,
            git,
            indexOwner: row.repo.indexOwner,
            ...(agent ? { agent } : {}),
            ...(guidance ? { guidance } : {}),
            ...(mcpServers.length ? { mcpServers } : {}),
            previousFindings: previous,
            conversation,
          },
        })
        .returning();
      await tx.insert(reviewTriggers).values({
        webhookId: h.id,
        repositoryId: row.repo.id,
        reviewId: review.id,
        commentId: event.commentId,
        change,
      });
      // Capture a stable PR identity without replacing newer refreshed provider state.
      await tx
        .insert(pullRequests)
        .values({
          publicId: publicId("pullRequest"),
          repositoryId: row.repo.id,
          number: change.number,
          title: change.title,
          url: change.url,
          state: "open",
          author: change.author ?? null,
          headSha: change.headSha,
          baseSha: change.baseSha,
          headBranch: change.headBranch ?? null,
          baseBranch: change.baseBranch ?? null,
        })
        .onConflictDoNothing({
          target: [pullRequests.repositoryId, pullRequests.number],
        });
      await tx
        .insert(dispatchOutbox)
        .values({ reviewId: review.id, publication: { state: "pending" } });
      await tx
        .update(repositoryWebhooks)
        .set({ lastDelivery: "accepted", lastDeliveryAt: new Date() })
        .where(eq(repositoryWebhooks.id, h.id));
      return review.publicId;
    });
    if (reviewId) {
      log.info({ deliveryId: delivery, reviewId }, "comment review queued");
      stage = "acknowledge-comment";
      await processInteraction(database, reviewId);
    }
    return outcome(202, "accepted");
  }

  try {
    if (normalizedEvent.kind === "push") return await handlePush();
    if (normalizedEvent.kind === "opened") return await handlePullRequest();
    return await handleComment();
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

/**
 * Serialize one review's acknowledgement or final publication, reconciling
 * remote markers before writes and preserving uncertain outcomes for later
 * recovery. Provider credential failures defer only this review's interaction.
 */
export async function processInteraction(database: Database, reviewId: string) {
  const [scope] = await database.db
    .select({
      repositoryId: repositories.publicId,
      change: reviewTriggers.change,
    })
    .from(reviewTriggers)
    .innerJoin(reviews, eq(reviewTriggers.reviewId, reviews.id))
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .where(
      and(eq(reviews.publicId, reviewId), eq(repositories.status, "active")),
    );
  if (!scope) return;
  const lock = `repository:${scope.repositoryId}`;
  await interactionLock(database, lock, async () => {
    const [entry] = await database.db
      .select({
        review: reviews,
        trigger: reviewTriggers,
        outbox: dispatchOutbox,
        repositoryId: repositories.publicId,
      })
      .from(reviews)
      .innerJoin(reviewTriggers, eq(reviewTriggers.reviewId, reviews.id))
      .innerJoin(dispatchOutbox, eq(dispatchOutbox.reviewId, reviews.id))
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .where(eq(reviews.publicId, reviewId));
    if (!entry) return;
    const { review, trigger, outbox } = entry;
    const row = await context(database, entry.repositoryId);
    if (row.repo.status !== "active" || !row.hook.enabled) return;
    if (!row.hook.botId) return;
    const bot = row.hook.botId;
    /**
     * Persist acknowledgement or publication progress and defer the next
     * interaction retry by thirty seconds.
     */
    const update = (values: Partial<typeof dispatchOutbox.$inferInsert>) =>
      database.db
        .update(dispatchOutbox)
        .set({ ...values, interactionAfter: new Date(Date.now() + 30000) })
        .where(eq(dispatchOutbox.id, outbox.id));
    let api: Forge;
    try {
      api = await adapter(database, row, outbox.acknowledgedAt ? 30000 : 6000);
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
    if (
      !["completed", "failed"].includes(review.status) ||
      ["published", "stale"].includes(outbox.publication?.state ?? "")
    )
      return;
    let progress: Publication = outbox.publication ?? { state: "pending" };
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
        if (
          current.headSha !== review.headSha ||
          current.baseSha !== trigger.change.baseSha
        )
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
            sql`${reviews.createdAt} > ${review.createdAt}`,
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
      if (payload?.recapReviewId) {
        const current = await api.change(trigger.change.number);
        if (
          (await hasNewerPublishedReview()) ||
          current.headSha !== review.headSha ||
          current.baseSha !== trigger.change.baseSha
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
      if (review.status === "completed" && !progress.stale) {
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
              if (
                latest.headSha !== review.headSha ||
                latest.baseSha !== trigger.change.baseSha
              ) {
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
      const existingComment =
        progress.mode !== "review"
          ? (await api.comments(trigger.change.number)).find(
              (c) =>
                c.user.id === bot && c.body.includes(`${marker}result -->`),
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
      const newer = await hasNewerPublishedReview();
      const change = await api.change(trigger.change.number);
      const stale =
        !!newer ||
        change.headSha !== review.headSha ||
        change.baseSha !== trigger.change.baseSha;
      if (stale || review.status === "failed") {
        if (progress.providerProgress && api.discardPendingReview)
          await api.discardPendingReview(
            trigger.change.number,
            review.publicId,
            progress.providerProgress,
          );
        const app =
          row.hook.mode === "github-app"
            ? await getRepositoryGithubApp(database, row.repo.id)
            : undefined;
        if (row.hook.mode === "github-app" && !app)
          throw new Error("GitHub App connection unavailable");
        const body = stale
          ? `Review of \`${review.headSha}\` is stale because the PR revisions changed or a newer review was published. Comment \`${reviewCommandText()}\` again to review the current changes.`
          : `Review of \`${review.headSha}\` failed. No results were published. Check review ${review.publicId} in razbor, then request a new review when resolved.`;
        progress = {
          ...progress,
          state: "publishing",
          mode: "comment",
          stale,
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
          publishedKeys,
          recapReviewId,
        } = await previousFindings(
          database,
          trigger.repositoryId,
          trigger.change.number,
          bot,
          api,
          review.publicId,
        );
        // A prior run may have published after this one was queued. Suppress
        // already-published findings using both the snapshot and fresh history.
        const previousKeys = new Set(
          [...previous, ...currentPrevious].map((p) => findingKey(p.finding)),
        );
        // A previously published finding without an assessment entry remains
        // outstanding if this run reports it again, without reposting it.
        const repeatedFindings = new Map(
          review
            .result!.findings.filter(
              (f) =>
                publishedKeys.has(findingKey(f)) &&
                !previousKeys.has(findingKey(f)),
            )
            .map((f) => [findingKey(f), f]),
        );
        const prepared = preparePublication(
          {
            ...review.result!,
            findings: review.result!.findings.filter(
              (f) =>
                !previousKeys.has(findingKey(f)) &&
                !publishedKeys.has(findingKey(f)),
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
        outstanding.push(
          ...[...repeatedFindings.values()].map((f) => ({
            title: f.title,
            severity: f.severity,
            finding: f,
            originalHead: review.headSha,
            status: "open" as const,
          })),
        );
        const needsChanges = !!(prepared.findings.length || outstanding.length);
        const target = needsChanges ? recapReviewId : undefined;
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
        };
      }
      const latest = await api.change(trigger.change.number);
      if (
        latest.headSha !== review.headSha ||
        latest.baseSha !== trigger.change.baseSha
      )
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
      const remoteId = await api.postReview(
        trigger.change.number,
        review.headSha,
        payload.recapReviewId ? `${marker}result -->` : payload.body,
        payload.comments,
        payload.event,
        {
          progress: progress.providerProgress ?? {},
          /** Save each provider operation before sending it and after confirming its ID. */
          async save(providerProgress) {
            progress = {
              ...progress,
              providerProgress: structuredClone(providerProgress),
            };
            await update({ publication: progress });
          },
        },
      );
      progress = { ...progress, remoteId, writing: false };
      await update({ publication: progress });
      progress.inlineIds = (
        await api.reviewComments(trigger.change.number, remoteId)
      )
        .filter((c) => c.body.includes(marker))
        .map((c) => c.id);
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
      const uncertain =
        (progress.writing ||
          Object.entries(progress.providerProgress ?? {}).some(
            ([key, operation]) => key.startsWith("fixed:") && operation.writing,
          )) &&
        (!(error instanceof ForgeOperationError) || error.uncertain);
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
    .where(
      and(
        eq(repositories.status, "active"),
        sql`${dispatchOutbox.interactionAfter} <= now() and (${dispatchOutbox.acknowledgedAt} is null or (${reviews.status} in ('completed','failed') and coalesce(${dispatchOutbox.publication}->>'state','pending') not in ('published','stale')))`,
      ),
    )
    .limit(10);
  for (const row of rows) await processInteraction(database, row.id);
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
        acknowledgementError: row.acknowledgedAt
          ? undefined
          : row.acknowledgement?.error,
        change: row.change,
      }
    : null;
}
