import { and, eq, sql } from "drizzle-orm";

import {
  githubInstallationSchema,
  publicIdSchema,
  type GithubInstallation,
} from "@razbor/contracts";
import {
  createGithubInstallationToken,
  listGithubAppInstallations,
  listGithubInstallationRepositories,
  readGithubApp,
  type ForgeConnection,
} from "@razbor/forge-adapters";

import {
  requireContextSession,
  resolveContextId,
} from "@database/src/contexts.js";
import type { Database } from "@database/src/connection.js";
import { githubApps, repositories } from "@database/src/schema.js";

/** Load server-only App credentials using an opaque public identifier. Never return this row to clients. */
export async function loadGithubApp(
  database: Database,
  id: string,
  contextId?: string,
) {
  publicIdSchema("githubApp").parse(id);
  const [app] = await database.db
    .select()
    .from(githubApps)
    .where(
      and(
        eq(githubApps.publicId, id),
        contextId === undefined
          ? undefined
          : sql`${githubApps.contextId} = (select id from account_contexts where public_id = ${contextId})`,
      ),
    );
  if (!app) throw new Error("GitHub App unavailable");
  return app;
}

/** Bind provider operations to the App's saved, validated HTTPS origins. */
export function githubAppConnection(
  app: typeof githubApps.$inferSelect,
): ForgeConnection {
  return {
    type: "github",
    apiUrl: app.apiUrl,
    webUrl: app.webUrl,
    allowHttp: false,
  };
}

/** Expose account-scoped installation links and display metadata for connection selection. */
export async function listGithubApps(database: Database, contextId?: string) {
  const apps = await database.db
    .select({
      id: githubApps.publicId,
      name: githubApps.name,
      slug: githubApps.slug,
      webUrl: githubApps.webUrl,
      appUrl: githubApps.appUrl,
      callbackBase: githubApps.callbackBase,
    })
    .from(githubApps)
    .where(
      contextId === undefined
        ? undefined
        : sql`${githubApps.contextId} = (select id from account_contexts where public_id = ${contextId})`,
    )
    .orderBy(githubApps.createdAt)
    .limit(100);
  return apps.map(({ appUrl, ...app }) => ({
    ...app,
    installUrl: `${appUrl}/installations/new`,
  }));
}

/** Persist one manifest-created App atomically in its initiating authorized account context. */
export async function saveGithubApp(
  database: Database,
  app: typeof githubApps.$inferInsert,
  sessionToken: string,
  contextId?: string,
) {
  publicIdSchema("githubApp").parse(app.publicId);
  await database.transaction(async (tx) => {
    await requireContextSession(
      tx,
      sessionToken,
      contextId ?? "",
      "repositories",
    );
    const ownerId = await resolveContextId(tx, contextId ?? "");
    await tx.insert(githubApps).values({ ...app, contextId: ownerId });
  });
}

/** Resolve and cache the immutable App bot identity after creation, without requiring a user token. */
export async function githubAppBot(
  database: Database,
  app: typeof githubApps.$inferSelect,
  token?: string,
) {
  if (app.bot) return app.bot;
  const verified = await readGithubApp(
    { ...githubAppConnection(app), token },
    {
      appId: app.externalId,
      privateKey: app.privateKey,
    },
  );
  await database.db
    .update(githubApps)
    .set({ bot: verified.bot, updatedAt: new Date() })
    .where(eq(githubApps.id, app.id));
  return verified.bot;
}

/** List repositories from the saved App's active installations; no callback query parameter grants access. */
export async function githubAppRepositories(
  database: Database,
  appId: string,
  contextId?: string,
) {
  const app = await loadGithubApp(database, appId, contextId);
  const connection = githubAppConnection(app);
  const credentials = { appId: app.externalId, privateKey: app.privateKey };
  const installations = (
    await listGithubAppInstallations(connection, credentials)
  ).filter((installation) => !installation.suspended);
  if (installations.length > 100)
    throw new Error("Too many GitHub installations");
  const available = [];
  for (const installation of installations) {
    const repos = await listGithubInstallationRepositories(
      connection,
      credentials,
      installation.id,
    );
    available.push(
      ...repos.map((repository) => ({
        ...repository,
        installationId: installation.id,
      })),
    );
  }
  return { installations, repositories: available };
}

/** Mint a token for an explicit saved App and repository, used before final repository registration. */
export async function githubInstallationAccess(
  database: Database,
  input: GithubInstallation,
  contextId?: string,
) {
  const reference = githubInstallationSchema.parse(input);
  const app = await loadGithubApp(database, reference.app_id, contextId);
  const connection = githubAppConnection(app);
  const { token } = await createGithubInstallationToken(
    connection,
    {
      appId: app.externalId,
      privateKey: app.privateKey,
    },
    reference.installation_id,
    reference.repository_id,
  );
  return {
    app,
    connection: {
      ...connection,
      token,
      githubAppBot: await githubAppBot(database, app, token),
    },
  };
}

/**
 * Mint a fresh repository-scoped token only for a registered, active binding.
 * Git callers must also supply their remotes so saved workspace policies cannot send a token elsewhere.
 */
export async function resolveGithubInstallationToken(
  database: Database,
  input: GithubInstallation,
  remotes?: string[],
) {
  const reference = githubInstallationSchema.parse(input);
  const [repo] = await database.db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.status, "active"),
        eq(repositories.externalRepositoryId, reference.repository_id),
        sql`${repositories.apiCredential}->'github_app' = ${JSON.stringify(reference)}::jsonb`,
      ),
    );
  if (!repo) throw new Error("GitHub installation binding unavailable");
  const app = await loadGithubApp(database, reference.app_id);
  const expected = `${app.webUrl.replace(/\/$/, "")}/${repo.observed?.fullPath ?? repo.selector}.git`;
  if (
    remotes &&
    (!remotes.length || remotes.some((remote) => remote !== expected))
  )
    throw new Error("GitHub installation remote mismatch");
  const { token } = await createGithubInstallationToken(
    githubAppConnection(app),
    {
      appId: app.externalId,
      privateKey: app.privateKey,
    },
    reference.installation_id,
    reference.repository_id,
  );
  return token;
}

/** Read the shared App webhook secret for internal signature checks, never for a console response. */
export async function readGithubAppWebhookSecret(
  database: Database,
  appId: string,
) {
  return (await loadGithubApp(database, appId)).webhookSecret;
}

/** Read trusted App bot identity and shared webhook location for one internal repository binding. */
export async function getRepositoryGithubApp(
  database: Database,
  repositoryId: string,
) {
  const [repo] = await database.db
    .select({
      credential: repositories.apiCredential,
      contextId: repositories.contextId,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  if (!repo?.credential || !("github_app" in repo.credential)) return undefined;
  const app = await loadGithubApp(database, repo.credential.github_app.app_id);
  if (app.contextId !== repo.contextId)
    throw new Error("GitHub installation binding unavailable");
  return {
    id: app.publicId,
    slug: app.slug,
    bot: await githubAppBot(database, app),
    callbackUrl: `${app.callbackBase}/webhooks/github-app/${app.publicId}`,
    appUrl: app.appUrl,
  };
}
