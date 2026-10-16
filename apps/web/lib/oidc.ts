import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import * as client from "openid-client";
import { NextResponse } from "next/server.js";

import { authenticateOidcUser } from "@razbor/database";

import { authenticationConfig } from "@web/lib/auth-config.js";
import {
  AuthError,
  authenticationDatabase,
  requestOrigin,
  setSessionCookie,
} from "@web/lib/auth.js";

type OidcSettings = NonNullable<
  Awaited<ReturnType<typeof authenticationConfig>>["oidc"]
>;

type LoginTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
  issuer: string;
  clientId: string;
  redirectUri: string;
};

const transactionCookieName = "razbor_oidc_transaction";

const transactionPath = "/api/auth/oidc";

const transactionLifetime = 600;

let discovered: Promise<client.Configuration> | undefined;

/** Discovers the configured issuer and enables ID-token signature verification without retaining tokens. */
function providerConfiguration(settings: OidcSettings) {
  discovered ??= client
    .discovery(
      new URL(settings.issuer),
      settings.client_id,
      settings.client_secret,
      settings.client_authentication === "client_secret_basic"
        ? client.ClientSecretBasic(settings.client_secret!)
        : settings.client_authentication === "client_secret_post"
          ? client.ClientSecretPost(settings.client_secret!)
          : client.None(),
      {
        timeout: 10,
        execute: [
          client.enableNonRepudiationChecks,
          ...(settings.allow_http ? [client.allowInsecureRequests] : []),
        ],
      },
    )
    .catch((error: unknown) => {
      discovered = undefined;
      throw error;
    });
  return discovered;
}

/** Seals the short-lived PKCE transaction so browser scripts cannot read or forge it. */
function sealTransaction(transaction: LoginTransaction, secret: string) {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(secret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(transactionCookieName));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

/** Opens exactly one authentic, unexpired transaction bound to this provider and callback. */
function readTransaction(
  request: Request,
  settings: OidcSettings,
): LoginTransaction {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${transactionCookieName}=`));
  if (values.length !== 1) throw new Error("Missing OIDC transaction");
  const value = values[0]!.slice(transactionCookieName.length + 1);
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(value))
    throw new Error("Invalid OIDC transaction");
  const sealed = Buffer.from(value, "base64url");
  const key = createHash("sha256").update(settings.transaction_secret).digest();
  const cipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  cipher.setAAD(Buffer.from(transactionCookieName));
  cipher.setAuthTag(sealed.subarray(12, 28));
  const transaction: unknown = JSON.parse(
    Buffer.concat([
      cipher.update(sealed.subarray(28)),
      cipher.final(),
    ]).toString("utf8"),
  );
  if (!transaction || typeof transaction !== "object")
    throw new Error("Invalid OIDC transaction");
  const candidate = transaction as Partial<LoginTransaction>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.nonce !== "string" ||
    typeof candidate.verifier !== "string" ||
    typeof candidate.expires !== "number" ||
    !Number.isFinite(candidate.expires) ||
    candidate.expires <= Date.now() ||
    candidate.expires > Date.now() + transactionLifetime * 1000 ||
    candidate.issuer !== settings.issuer ||
    candidate.clientId !== settings.client_id ||
    candidate.redirectUri !== settings.redirect_uri
  )
    throw new Error("Invalid OIDC transaction");
  return candidate as LoginTransaction;
}

/** Writes or clears the transaction with an HTTP-only cookie confined to OIDC endpoints. */
function transactionCookie(
  response: NextResponse,
  settings: OidcSettings,
  value = "",
) {
  response.cookies.set(transactionCookieName, value, {
    httpOnly: true,
    secure: new URL(settings.redirect_uri).protocol === "https:",
    sameSite: "lax",
    path: transactionPath,
    maxAge: value ? transactionLifetime : 0,
  });
}

/** Redirects to a fixed, safe sign-in error and consumes any transaction without exposing provider details. */
function failedLogin(settings: OidcSettings) {
  const response = NextResponse.redirect(
    new URL("/login?error=oidc", settings.redirect_uri),
    303,
  );
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  transactionCookie(response, settings);
  return response;
}

/** Reads an own-property claim path without treating inherited object properties as identity claims. */
function claimAt(claims: Record<string, unknown>, path: string) {
  let value: unknown = claims;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment))
      return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** Maps exact verified group strings to roles, giving any explicit administrator match precedence. */
function roleFromClaims(
  settings: OidcSettings,
  claims: Record<string, unknown>,
) {
  const rawGroups = claimAt(claims, settings.groups_claim);
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((group): group is string => typeof group === "string")
    : typeof rawGroups === "string"
      ? [rawGroups]
      : [];
  const roles = groups
    .filter((group) => Object.hasOwn(settings.group_roles, group))
    .map((group) => settings.group_roles[group]);
  return roles.includes("super_admin")
    ? "super_admin"
    : roles.includes("user")
      ? "user"
      : settings.default_role;
}

/** Keeps bounded, printable profile text while ignoring malformed optional claims without rejecting sign-in. */
function profileText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength) return undefined;
  const hasControls = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return hasControls ? undefined : text;
}

/** Starts a code flow with S256 PKCE, state, and nonce on the configured external origin. */
export async function startOidcLogin(request: Request) {
  const settings = (await authenticationConfig()).oidc;
  if (!settings)
    throw new AuthError(404, "Identity provider sign-in is disabled.");
  try {
    if (requestOrigin(request) !== new URL(settings.redirect_uri).origin)
      throw new Error("Invalid OIDC origin");
    const configuration = await providerConfiguration(settings);
    const transaction: LoginTransaction = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      expires: Date.now() + transactionLifetime * 1000,
      issuer: settings.issuer,
      clientId: settings.client_id,
      redirectUri: settings.redirect_uri,
    };
    const location = client.buildAuthorizationUrl(configuration, {
      redirect_uri: settings.redirect_uri,
      scope: settings.scopes.join(" "),
      code_challenge: await client.calculatePKCECodeChallenge(
        transaction.verifier,
      ),
      code_challenge_method: "S256",
      state: transaction.state,
      nonce: transaction.nonce,
      response_mode: "query",
    });
    const response = NextResponse.redirect(location, 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    transactionCookie(
      response,
      settings,
      sealTransaction(transaction, settings.transaction_secret),
    );
    return response;
  } catch {
    return failedLogin(settings);
  }
}

/** Validates the callback and verified subject, then creates or refreshes its issuer-bound console account. */
export async function finishOidcLogin(request: Request) {
  const settings = (await authenticationConfig()).oidc;
  if (!settings)
    throw new AuthError(404, "Identity provider sign-in is disabled.");
  try {
    const incoming = new URL(request.url);
    const callback = new URL(settings.redirect_uri);
    if (
      requestOrigin(request) !== callback.origin ||
      incoming.pathname !== callback.pathname
    )
      throw new Error("Invalid OIDC callback");
    callback.search = incoming.search;
    const transaction = readTransaction(request, settings);
    const configuration = await providerConfiguration(settings);
    const tokens = await client.authorizationCodeGrant(
      configuration,
      callback,
      {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      },
    );
    const idClaims = tokens.claims();
    if (!idClaims || typeof idClaims.sub !== "string" || !idClaims.sub)
      throw new Error("Missing OIDC subject");
    const userInfo = configuration.serverMetadata().userinfo_endpoint
      ? await client.fetchUserInfo(
          configuration,
          tokens.access_token,
          idClaims.sub,
        )
      : undefined;
    // UserInfo is authoritative where present; the library binds its subject to the verified ID token.
    const claims: Record<string, unknown> = { ...idClaims, ...userInfo };
    const emailClaim = profileText(claims.email, 320);
    const email =
      emailClaim && /^[^\s@]+@[^\s@]+$/.test(emailClaim)
        ? emailClaim
        : undefined;
    const fullName = [
      profileText(claims.given_name, 256),
      profileText(claims.family_name, 256),
    ]
      .filter(Boolean)
      .join(" ");
    const displayName =
      profileText(claims.name, 256) ??
      profileText(fullName, 256) ??
      profileText(claims.preferred_username, 256) ??
      profileText(email, 256);
    const session = await authenticateOidcUser(await authenticationDatabase(), {
      issuer: settings.issuer,
      subject: idClaims.sub,
      role: roleFromClaims(settings, claims),
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {}),
    });
    if (!session) throw new Error("OIDC account disabled");
    const response = NextResponse.redirect(
      new URL("/", settings.redirect_uri),
      303,
    );
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    setSessionCookie(response, request, session);
    transactionCookie(response, settings);
    return response;
  } catch {
    return failedLogin(settings);
  }
}
