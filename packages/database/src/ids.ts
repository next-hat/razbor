import { customAlphabet } from "nanoid";

import { publicIdPrefixes, type ResourceKind } from "@razbor/contracts";

const suffix = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  16,
);

/** Generate an opaque random identifier with the resource's public prefix. */
export const publicId = (kind: ResourceKind) =>
  `${publicIdPrefixes[kind]}_${suffix()}`;

const publicConstraints = new Set([
  "console_users_public_id_unique",
  "account_contexts_public_id_unique",
  "organization_invitations_public_id_unique",
  "agents_public_id_unique",
  "skills_public_id_unique",
  "mcp_servers_public_id_unique",
  "runners_public_id_unique",
  "forge_instances_public_id_unique",
  "github_apps_public_id_unique",
  "repository_webhooks_public_id_unique",
  "repositories_public_id_unique",
  "pull_requests_public_id_unique",
  "index_workspaces_public_id_unique",
  "index_access_tokens_public_id_unique",
  "reviews_public_id_unique",
  "review_attempts_public_id_unique",
  "memory_collections_public_id_unique",
  "memory_documents_public_id_unique",
]);

/**
 * Retry an operation at most twice for known public ID uniqueness conflicts;
 * propagate all other database errors.
 */
export async function retryPublicIdCollision<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause ?? error;
      const pg = cause as { code?: string; constraint?: string };
      if (
        attempt >= 2 ||
        pg.code !== "23505" ||
        !publicConstraints.has(pg.constraint ?? "")
      )
        throw error;
    }
  }
}
