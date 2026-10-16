import { constants, createPrivateKey, sign } from "node:crypto";

import { z } from "zod";

import { approvedUrl, providerId, readJson } from "@forge-adapters/src/http.js";
import { ForgeOperationError } from "@forge-adapters/src/interactions.js";
import { HttpForgeTransport } from "@forge-adapters/src/transport.js";
import type { ForgeConnection } from "@forge-adapters/src/types.js";

const id = providerId.pipe(z.string().regex(/^[1-9]\d*$/));

const login = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^:\r\n\0]+$/);

const appSchema = z.object({
  id,
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(200),
  html_url: z.string().url(),
});

const installationSchema = z.object({
  id,
  app_id: id,
  account: z.object({ id, login }),
  suspended_at: z.string().nullable(),
});

const repositorySchema = z.object({
  id,
  full_name: z.string().min(1).max(512),
  default_branch: z.string().optional(),
  private: z.boolean(),
  archived: z.boolean(),
});

export type GithubAppCredentials = {
  appId: string;
  privateKey: string;
};

/** Create a short-lived RS256 App JWT with clock-skew tolerance and no stored token. */
export function createGithubAppJwt(credentials: GithubAppCredentials): string {
  try {
    const appId = id.parse(credentials.appId);
    const privateKey = createPrivateKey(
      z.string().min(1).max(20000).parse(credentials.privateKey),
    );
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new ForgeOperationError("invalid-response");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: appId, iat: now - 60, exp: now + 540 }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64url");
    return `${input}.${signature}`;
  } catch {
    throw new ForgeOperationError("invalid-response");
  }
}

/** Bind App credentials to the configured HTTPS API and the existing bounded transport. */
function appTransport(
  connection: ForgeConnection,
  credentials?: GithubAppCredentials,
) {
  if (connection.type !== "github" || connection.allowHttp)
    throw new ForgeOperationError("unsupported");
  approvedUrl(connection.apiUrl, false);
  approvedUrl(connection.webUrl, false);
  return new HttpForgeTransport(connection, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(credentials
      ? { Authorization: `Bearer ${createGithubAppJwt(credentials)}` }
      : {}),
  });
}

/** Validate the App page against the trusted forge origin before exposing an install link. */
function appMetadata(connection: ForgeConnection, value: unknown) {
  const app = appSchema.parse(value);
  const web = approvedUrl(connection.webUrl, false);
  const url = approvedUrl(app.html_url, false);
  if (
    url.origin !== web.origin ||
    url.pathname !== `${web.pathname.replace(/\/$/, "")}/apps/${app.slug}`
  )
    throw new ForgeOperationError("invalid-response");
  return { id: app.id, slug: app.slug, name: app.name, htmlUrl: url.href };
}

/** Exchange a one-use manifest code for credentials; the caller must validate CSRF state first. */
export async function convertGithubAppManifest(
  connection: ForgeConnection,
  code: string,
) {
  try {
    const value = await appTransport(connection).request(
      `app-manifests/${encodeURIComponent(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^[A-Za-z0-9_-]+$/)
          .parse(code),
      )}/conversions`,
      "POST",
    );
    const credentials = z
      .object({
        client_id: z.string().min(1).max(256),
        client_secret: z.string().min(1).max(4096),
        pem: z.string().min(1).max(20000),
        webhook_secret: z.string().min(1).max(4096),
      })
      .parse(value);
    const app = appMetadata(connection, value);
    // Validate the returned key before the caller persists this one-use response.
    createGithubAppJwt({ appId: app.id, privateKey: credentials.pem });
    return {
      ...app,
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      privateKey: credentials.pem,
      webhookSecret: credentials.webhook_secret,
    };
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    throw new ForgeOperationError("invalid-response");
  }
}

/** Authenticate the App key and resolve its exact public bot identity for review attribution. */
export async function readGithubApp(
  connection: ForgeConnection,
  credentials: GithubAppCredentials,
) {
  try {
    const app = appMetadata(
      connection,
      await appTransport(connection, credentials).request("app"),
    );
    if (app.id !== credentials.appId)
      throw new ForgeOperationError("permission");
    const botLogin = `${app.slug}[bot]`;
    const bot = z.object({ id, login, type: z.literal("Bot") }).parse(
      await readJson(connection, `users/${encodeURIComponent(botLogin)}`, {
        "X-GitHub-Api-Version": "2022-11-28",
        ...(connection.token
          ? { Authorization: `Bearer ${connection.token}` }
          : {}),
      }),
    );
    if (bot.login.toLowerCase() !== botLogin.toLowerCase())
      throw new ForgeOperationError("invalid-response");
    return { ...app, bot: { id: bot.id, login: bot.login } };
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    throw new ForgeOperationError("invalid-response");
  }
}

/** List this App's installations with bounded pagination and explicit suspension state. */
export async function listGithubAppInstallations(
  connection: ForgeConnection,
  credentials: GithubAppCredentials,
) {
  try {
    const installations = z
      .array(installationSchema)
      .parse(
        await appTransport(connection, credentials).list("app/installations"),
      );
    if (
      installations.some(
        (installation) => installation.app_id !== credentials.appId,
      )
    )
      throw new ForgeOperationError("invalid-response");
    return installations.map((installation) => ({
      id: installation.id,
      account: installation.account,
      suspended: installation.suspended_at !== null,
    }));
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    throw new ForgeOperationError("invalid-response");
  }
}

/** Verify active App ownership and mint an expiring token, optionally restricted to one exact repository. */
export async function createGithubInstallationToken(
  connection: ForgeConnection,
  credentials: GithubAppCredentials,
  installationId: string,
  repositoryId?: string,
) {
  try {
    const transport = appTransport(connection, credentials);
    const installation = installationSchema.parse(
      await transport.request(`app/installations/${id.parse(installationId)}`),
    );
    if (
      installation.id !== installationId ||
      installation.app_id !== credentials.appId ||
      installation.suspended_at !== null
    )
      throw new ForgeOperationError("permission");
    const repositoryNumber =
      repositoryId === undefined ? undefined : Number(id.parse(repositoryId));
    if (
      repositoryNumber !== undefined &&
      (!Number.isSafeInteger(repositoryNumber) ||
        String(repositoryNumber) !== repositoryId)
    )
      throw new ForgeOperationError("invalid-response");
    const result = z
      .object({
        token: z
          .string()
          .min(1)
          .max(16384)
          .regex(/^[^\r\n\0]+$/),
        expires_at: z.string().datetime({ offset: true }),
        repositories: z.array(z.object({ id })).optional(),
      })
      .parse(
        await transport.request(
          `app/installations/${installation.id}/access_tokens`,
          "POST",
          repositoryNumber === undefined
            ? {}
            : { repository_ids: [repositoryNumber] },
        ),
      );
    const expiresAt = Date.parse(result.expires_at);
    if (
      expiresAt <= Date.now() + 60000 ||
      expiresAt > Date.now() + 3660000 ||
      (repositoryId !== undefined &&
        result.repositories !== undefined &&
        (result.repositories.length !== 1 ||
          result.repositories[0]?.id !== repositoryId))
    )
      throw new ForgeOperationError("invalid-response");
    return { token: result.token, expiresAt: result.expires_at };
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    throw new ForgeOperationError("invalid-response");
  }
}

/** List repositories available to an active installation, failing if pagination cannot finish. */
export async function listGithubInstallationRepositories(
  connection: ForgeConnection,
  credentials: GithubAppCredentials,
  installationId: string,
) {
  try {
    const { token } = await createGithubInstallationToken(
      connection,
      credentials,
      installationId,
    );
    const transport = new HttpForgeTransport(connection, {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    });
    const repositories: z.infer<typeof repositorySchema>[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = z
        .object({ repositories: z.array(repositorySchema).max(50) })
        .parse(
          await transport.request(
            `installation/repositories?per_page=50&page=${page}`,
          ),
        );
      repositories.push(...result.repositories);
      if (result.repositories.length < 50)
        return repositories.map((repository) => ({
          id: repository.id,
          fullName: repository.full_name,
          defaultBranch: repository.default_branch,
          private: repository.private,
          archived: repository.archived,
        }));
    }
    throw new ForgeOperationError("invalid-response");
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    throw new ForgeOperationError("invalid-response");
  }
}
