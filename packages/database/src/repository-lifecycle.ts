import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { createForge, verifyRegistration } from "@razbor/forge-adapters";

import { requireContextSession } from "@database/src/contexts.js";
import type { Database } from "@database/src/connection.js";
import { getRepository } from "@database/src/registry.js";
import {
  forgeInstances,
  indexWorkspaces,
  repositories,
  repositoryWebhooks,
  reviewAttempts,
  reviews,
  storedSecrets,
} from "@database/src/schema.js";

export class RepositoryManagementError extends Error {
  /** Carry an API-safe status and message for repository lifecycle operations. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve setup defaults from environment settings, then an existing active
 * webhook where available.
 */
export async function repositorySetupDefaults(
  database: Database,
  contextId?: string,
) {
  const [hook] = await database.db
    .select({ callbackBase: repositoryWebhooks.callbackBase })
    .from(repositoryWebhooks)
    .innerJoin(
      repositories,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(repositories.status, "active"),
        contextId === undefined
          ? undefined
          : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      ),
    )
    .orderBy(repositoryWebhooks.createdAt)
    .limit(1);
  return {
    callbackBase:
      process.env.RAZBOR_WEBHOOK_CALLBACK_BASE || hook?.callbackBase || "",
    indexOwner: process.env.RAZBOR_INDEX_OWNER || "local-indexer",
  };
}

/**
 * Require the exact repository name, then atomically disable ingress, fence
 * outstanding reviews and mark workspaces for asynchronous cleanup.
 */
export async function requestRepositoryDeletion(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
) {
  publicIdSchema("repository").parse(id);
  const { confirmation } = z
    .object({ confirmation: z.string() })
    .strict()
    .parse(input);
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
          eq(repositories.publicId, id),
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      )
      .for("update");
    if (!repo)
      throw new RepositoryManagementError(404, "Repository not found.");
    if (confirmation !== (repo.selector ?? repo.configKey))
      throw new RepositoryManagementError(
        400,
        "Type the exact repository name to confirm deletion.",
      );
    const now = new Date();
    await tx
      .update(repositories)
      .set({
        status: "deleting",
        setupError: null,
        version: repo.version + 1,
        updatedAt: now,
      })
      .where(eq(repositories.id, repo.id));
    await tx
      .update(repositoryWebhooks)
      .set({ enabled: false, updatedAt: now })
      .where(eq(repositoryWebhooks.repositoryId, repo.id));
    await tx
      .update(reviews)
      .set({
        status: "failed",
        version: sql`${reviews.version} + 1`,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(reviews.repositoryId, repo.id),
          inArray(reviews.status, ["queued", "running"]),
        ),
      );
    await tx
      .update(reviewAttempts)
      .set({
        status: "abandoned",
        finishedAt: now,
        updatedAt: now,
        leaseUntil: now,
      })
      .where(
        and(
          eq(reviewAttempts.status, "running"),
          sql`${reviewAttempts.reviewId} in (select id from reviews where repository_id = ${repo.id})`,
        ),
      );
    await tx
      .update(indexWorkspaces)
      .set({ state: "deleting", updatedAt: now })
      .where(
        and(
          eq(indexWorkspaces.repositoryId, repo.id),
          sql`${indexWorkspaces.state} <> 'deleted'`,
        ),
      );
  });
  return { id, status: "deleting" as const };
}

/**
 * Requeue index and webhook setup for an active repository, rejecting missing
 * or deleting repositories.
 */
export async function retryRepositorySetup(
  database: Database,
  id: string,
  contextId?: string,
  sessionToken?: string,
) {
  publicIdSchema("repository").parse(id);
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
          eq(repositories.publicId, id),
          contextId === undefined
            ? undefined
            : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
        ),
      )
      .for("update");
    if (!repo)
      throw new RepositoryManagementError(404, "Repository not found.");
    if (repo.status !== "active")
      throw new RepositoryManagementError(
        409,
        "Repository deletion is in progress.",
      );
    await tx
      .update(repositories)
      .set({ setupState: "pending", setupError: null, updatedAt: new Date() })
      .where(eq(repositories.id, repo.id));
    await tx
      .update(repositoryWebhooks)
      .set({
        setup: sql`case when ${repositoryWebhooks.mode} = 'manual' and ${repositoryWebhooks.setup} = 'ready' then 'ready' when ${repositoryWebhooks.mode} = 'manual' then 'manual' else 'pending' end`,
        updatedAt: new Date(),
      })
      .where(eq(repositoryWebhooks.repositoryId, repo.id));
  });
  return getRepository(database, id, contextId);
}

/**
 * Verify new forge access before saving it; preserve repository and bot identity and
 * version, update persistent Git credentials, or restore webhook cleanup
 * access during deletion.
 */
export async function replaceRepositoryToken(
  database: Database,
  id: string,
  input: unknown,
  contextId?: string,
  sessionToken?: string,
) {
  publicIdSchema("repository").parse(id);
  const { accessToken } = z
    .object({
      accessToken: z
        .string()
        .trim()
        .min(1)
        .max(8192)
        .regex(/^[^\s\0]+$/),
    })
    .strict()
    .parse(input);
  const [before] = await database.db
    .select({ repo: repositories, forge: forgeInstances })
    .from(repositories)
    .innerJoin(
      forgeInstances,
      and(
        eq(repositories.forgeId, forgeInstances.id),
        sql`${forgeInstances.contextId} is not distinct from ${repositories.contextId}`,
      ),
    )
    .where(
      and(
        eq(repositories.publicId, id),
        contextId === undefined
          ? undefined
          : sql`${repositories.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      ),
    );
  if (!before)
    throw new RepositoryManagementError(404, "Hosted repository not found.");
  if (before.repo.apiCredential && "github_app" in before.repo.apiCredential)
    throw new RepositoryManagementError(
      409,
      "This repository uses a GitHub App. Restore the App installation's repository access, then retry setup.",
    );
  if (before.repo.status === "deleting") {
    let identity;
    try {
      identity = await createForge(
        {
          type: before.forge.type,
          apiUrl: before.forge.apiUrl,
          webUrl: before.forge.webUrl,
          allowHttp: before.forge.allowHttp,
          token: accessToken,
        },
        before.repo.selector!,
      ).identity();
    } catch {
      throw new RepositoryManagementError(
        400,
        "Token verification failed. Check bot access.",
      );
    }
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
        .where(eq(repositories.id, before.repo.id))
        .for("update");
      if (repo?.status !== "deleting")
        throw new RepositoryManagementError(
          409,
          "Repository changed. Reload and try again.",
        );
      const [hook] = await tx
        .select({ botId: repositoryWebhooks.botId })
        .from(repositoryWebhooks)
        .where(eq(repositoryWebhooks.repositoryId, repo.id))
        .for("update");
      if (hook?.botId && hook.botId !== identity.id)
        throw new RepositoryManagementError(
          409,
          "Use a replacement token for the same bot identity. The token was not saved.",
        );
      const tokenId =
        repo.apiCredential && "stored" in repo.apiCredential
          ? repo.apiCredential.stored
          : randomUUID();
      await tx
        .insert(storedSecrets)
        .values({ id: tokenId, repositoryId: repo.id, value: accessToken })
        .onConflictDoUpdate({
          target: storedSecrets.id,
          set: { value: accessToken },
        });
      await tx
        .update(repositories)
        .set({
          apiCredential: { stored: tokenId },
          setupError: null,
          updatedAt: new Date(),
        })
        .where(eq(repositories.id, repo.id));
    });
    return getRepository(database, id, contextId);
  }
  let verified;
  try {
    verified = await verifyRegistration(
      {
        type: before.forge.type,
        apiUrl: before.forge.apiUrl,
        webUrl: before.forge.webUrl,
        allowHttp: before.forge.allowHttp,
        token: accessToken,
      },
      before.repo.selector!,
      before.repo.git.branch,
    );
  } catch {
    throw new RepositoryManagementError(
      400,
      "Token verification failed. Check bot access, repository permissions, and branch.",
    );
  }
  if (
    before.repo.externalRepositoryId &&
    before.repo.externalRepositoryId !== verified.metadata.externalRepositoryId
  )
    throw new RepositoryManagementError(
      409,
      "Repository identity changed. The token was not saved.",
    );
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
      .where(eq(repositories.id, before.repo.id))
      .for("update");
    if (repo?.status !== "active" || repo.version !== before.repo.version)
      throw new RepositoryManagementError(
        409,
        "Repository changed. Reload and try again.",
      );
    const [hook] = await tx
      .select({ botId: repositoryWebhooks.botId })
      .from(repositoryWebhooks)
      .where(eq(repositoryWebhooks.repositoryId, repo.id))
      .for("update");
    if (hook?.botId && hook.botId !== verified.identity.id)
      throw new RepositoryManagementError(
        409,
        "Use a replacement token for the same bot identity. The token was not saved.",
      );
    const tokenId =
      repo.apiCredential && "stored" in repo.apiCredential
        ? repo.apiCredential.stored
        : randomUUID();
    await tx
      .insert(storedSecrets)
      .values({ id: tokenId, repositoryId: repo.id, value: accessToken })
      .onConflictDoUpdate({
        target: storedSecrets.id,
        set: { value: accessToken },
      });
    const remoteName = repo.git.upstream.split("/")[2];
    const git = {
      ...repo.git,
      remotes: { [remoteName]: verified.cloneUrl },
      credentials: {
        kind: "https" as const,
        username: verified.gitUsername ?? verified.identity.login,
        token_id: tokenId,
      },
    };
    await tx
      .update(repositories)
      .set({
        git,
        apiCredential: { stored: tokenId },
        setupState: "pending",
        setupError: null,
        version: repo.version + 1,
        externalRepositoryId: verified.metadata.externalRepositoryId,
        observed: verified.metadata,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repo.id));
    await tx
      .update(indexWorkspaces)
      .set({ git, updatedAt: new Date() })
      .where(
        and(
          eq(indexWorkspaces.repositoryId, repo.id),
          eq(indexWorkspaces.temporary, false),
        ),
      );
    await tx
      .update(repositoryWebhooks)
      .set({
        setup: sql`case when ${repositoryWebhooks.mode} = 'manual' and ${repositoryWebhooks.setup} = 'ready' then 'ready' when ${repositoryWebhooks.mode} = 'manual' then 'manual' else 'pending' end`,
        updatedAt: new Date(),
      })
      .where(eq(repositoryWebhooks.repositoryId, repo.id));
  });
  return getRepository(database, id, contextId);
}
