import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { verifyGithubWebhook } from "@razbor/forge-adapters";

import type { Database } from "@database/src/connection.js";
import { loadGithubApp } from "@database/src/github-apps.js";
import { repositories, repositoryWebhooks } from "@database/src/schema.js";
import { acceptWebhook } from "@database/src/webhooks.js";

const providerId = z.union([
  z.string().regex(/^[1-9]\d{0,19}$/),
  z.number().int().positive().safe().transform(String),
]);

/**
 * Authenticate the App envelope before selecting a repository. A signed event
 * must match both the saved installation and immutable external repository ID.
 */
export async function acceptGithubAppWebhook(
  database: Database,
  appId: string,
  raw: Uint8Array,
  headers: Record<string, string | undefined>,
  refreshIndex?: (repositoryId: string) => Promise<unknown>,
) {
  const app = await loadGithubApp(database, appId);
  if (
    !verifyGithubWebhook(raw, headers["x-hub-signature-256"], app.webhookSecret)
  )
    return 401;
  if (!/^[A-Za-z0-9-]{1,200}$/.test(headers["x-github-delivery"] ?? ""))
    return 400;
  const event = headers["x-github-event"];
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return 400;
  }
  // The App-level registration ping has no repository or installation.
  if (event === "ping") return 200;
  const parsed = z
    .object({
      action: z.string().optional(),
      installation: z.object({ id: providerId, app_id: providerId.optional() }),
      repository: z.object({ id: providerId }).optional(),
      repositories_removed: z
        .array(z.object({ id: providerId }))
        .max(1000)
        .optional(),
    })
    .safeParse(value);
  if (!parsed.success) return 400;
  const envelope = parsed.data;
  if (
    envelope.installation.app_id &&
    envelope.installation.app_id !== app.externalId
  )
    return 403;
  const binding = and(
    sql`${repositories.apiCredential}->'github_app'->>'app_id' = ${app.publicId}`,
    sql`${repositories.apiCredential}->'github_app'->>'installation_id' = ${envelope.installation.id}`,
  );
  if (event === "installation" || event === "installation_repositories") {
    const revoked =
      event === "installation" &&
      ["deleted", "suspend"].includes(envelope.action ?? "");
    const removed =
      envelope.repositories_removed?.map((repository) => repository.id) ?? [];
    if (revoked || removed.length) {
      const affected = await database.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            binding,
            revoked
              ? undefined
              : inArray(repositories.externalRepositoryId, removed),
          ),
        );
      if (affected.length)
        await database.db
          .update(repositoryWebhooks)
          .set({ setup: "installation-unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(repositoryWebhooks.mode, "github-app"),
              inArray(
                repositoryWebhooks.repositoryId,
                affected.map((repository) => repository.id),
              ),
            ),
          );
    }
    return 200;
  }
  if (!envelope.repository) return 204;
  const [row] = await database.db
    .select({ hookId: repositoryWebhooks.publicId })
    .from(repositories)
    .innerJoin(
      repositoryWebhooks,
      eq(repositoryWebhooks.repositoryId, repositories.id),
    )
    .where(
      and(
        binding,
        eq(repositories.externalRepositoryId, envelope.repository.id),
        eq(repositoryWebhooks.mode, "github-app"),
      ),
    );
  if (!row) return 204;
  return acceptWebhook(database, row.hookId, raw, headers, refreshIndex, {
    githubAppId: app.publicId,
  });
}
