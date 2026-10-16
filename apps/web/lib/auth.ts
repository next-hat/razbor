import { cache } from "react";
import { cookies } from "next/headers.js";
import { notFound, redirect } from "next/navigation.js";
import { NextResponse } from "next/server.js";
import { ZodError } from "zod";

import {
  AuthInputError,
  bootstrapAdministrator,
  getSessionUser,
  listAccountContexts,
  type ContextView,
  type ConsoleSession,
  type ConsoleUserView,
} from "@razbor/database";

import { authenticationConfig } from "@web/lib/auth-config.js";
import { reviewDatabase } from "@web/lib/review.js";

export const sessionCookieName = "razbor_session";

export const contextCookieName = "razbor_context";

export type ManagedResource =
  "repository" | "agent" | "skill" | "mcp" | "indexer" | "organization";

export type ContextualUser = ConsoleUserView & {
  context: ContextView;
  contexts: ContextView[];
  contextUnavailable?: boolean;
};

let bootstrap: Promise<void> | undefined;

/** Opens account storage and initializes a local administrator only when password sign-in is enabled. */
export async function authenticationDatabase() {
  const database = await reviewDatabase();
  if (!(await authenticationConfig()).local_enabled) return database;
  bootstrap ??= bootstrapAdministrator(database).catch((error: unknown) => {
    bootstrap = undefined;
    throw error;
  });
  await bootstrap;
  return database;
}

/** Carries an HTTP status for a rejected console authentication or access check. */
export class AuthError extends Error {
  /** Creates a safe, public error without account or credential details. */
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads only the opaque session cookie, tolerating invalid or duplicated cookie values. */
export function requestSessionToken(request: Request) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${sessionCookieName}=`));
  return values.length === 1
    ? values[0]!.slice(sessionCookieName.length + 1)
    : undefined;
}

/** Resolves the request's current account and repository grants from a live session. */
export async function readRequestUser(request: Request) {
  const token = requestSessionToken(request);
  const user = await permittedSessionUser(token);
  if (!user) return undefined;
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${contextCookieName}=`));
  return contextualUser(
    user,
    values.length === 1
      ? values[0]!.slice(contextCookieName.length + 1)
      : values.length
        ? "invalid"
        : undefined,
  );
}

/** Resolves the live account independently of a selected context, allowing stale selections to be repaired. */
export async function requireApiAccount(request: Request) {
  const user = await permittedSessionUser(requestSessionToken(request));
  if (!user) throw new AuthError(401, "Sign in to continue.");
  if (user.mustChangePassword)
    throw new AuthError(403, "Change your password to continue.");
  return user;
}

/** Builds current context permissions from storage; an inaccessible selection grants no resources. */
async function contextualUser(
  user: ConsoleUserView,
  selection?: string,
): Promise<ContextualUser> {
  const contexts = await listAccountContexts(
    await authenticationDatabase(),
    user,
  );
  const context = selection
    ? contexts.find((entry) => entry.id === selection)
    : contexts.find(
        (entry) => entry.kind === "personal" && entry.role === "owner",
      );
  if (!context)
    return {
      ...user,
      repositoryIds: [],
      contexts,
      contextUnavailable: true,
      context: {
        id: selection ?? "",
        name: "Unavailable context",
        kind: "organization",
        role: "member",
        repositoryIds: [],
      },
    };
  return { ...user, contexts, context, repositoryIds: context.repositoryIds };
}

/** Checks management rights in the selected owner context, independently of instance administration. */
export function canManageResource(
  user: ContextualUser,
  resource: ManagedResource,
) {
  if (user.contextUnavailable) return false;
  if (user.role === "super_admin") return true;
  if (resource === "organization")
    return (
      user.context.kind === "organization" && user.context.role === "admin"
    );
  return (
    user.context.role === "owner" ||
    user.context.role === "admin" ||
    (user.context.role === "moderator" &&
      ["repository", "skill", "mcp"].includes(resource))
  );
}

/** Returns the authorized selected context for scoped resource storage calls. */
export async function requestContextId(request: Request) {
  return (await requireApiUser(request)).context.id;
}

/** Rejects sessions from disabled sign-in methods or a replaced OIDC provider. */
async function permittedSessionUser(token?: string) {
  if (!token) return undefined;
  const configuration = await authenticationConfig();
  const user = await getSessionUser(await authenticationDatabase(), token);
  if (!user) return undefined;
  return user.authenticationMethod === "oidc"
    ? configuration.oidc && user.oidcIssuer === configuration.oidc.issuer
      ? user
      : undefined
    : configuration.local_enabled
      ? user
      : undefined;
}

/** Reuses the session read within a server render, without caching across requests. */
export const currentUser = cache(async () => {
  const jar = await cookies();
  const user = await permittedSessionUser(jar.get(sessionCookieName)?.value);
  return user
    ? contextualUser(user, jar.get(contextCookieName)?.value)
    : undefined;
});

/** Checks repository grants derived from the currently selected account context. */
export function canAccessRepository(
  user: ConsoleUserView,
  repositoryId: string,
) {
  return user.repositoryIds.includes(repositoryId);
}

/** Guards server pages before any protected data is loaded or passed to client components. */
export async function requirePageUser(
  options: {
    admin?: boolean;
    resource?: ManagedResource;
    repositoryId?: string;
  } = {},
) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (
    user.contextUnavailable ||
    (options.admin && user.role !== "super_admin") ||
    (options.resource && !canManageResource(user, options.resource)) ||
    (options.repositoryId && !canAccessRepository(user, options.repositoryId))
  )
    notFound();
  return user;
}

/** Guards route handlers independently of middleware, including mandatory password changes. */
export async function requireApiUser(
  request: Request,
  options: {
    admin?: boolean;
    resource?: ManagedResource;
    repositoryId?: string;
    allowPasswordChange?: boolean;
  } = {},
) {
  const user = await readRequestUser(request);
  if (!user) throw new AuthError(401, "Sign in to continue.");
  if (user.mustChangePassword && !options.allowPasswordChange)
    throw new AuthError(403, "Change your password to continue.");
  if (user.contextUnavailable && !options.allowPasswordChange)
    throw new AuthError(403, "Select an accessible account context.");
  if (options.admin && user.role !== "super_admin")
    throw new AuthError(403, "Administrator access required.");
  if (options.resource && !canManageResource(user, options.resource))
    throw new AuthError(403, "Resource management access required.");
  if (options.repositoryId && !canAccessRepository(user, options.repositoryId))
    throw new AuthError(404, "Repository not found.");
  return user;
}

/**
 * Resolves the externally requested HTTP origin from the preserved Host and
 * forwarded protocol, rejecting credentials, paths, and invalid host values.
 * Next.js may replace the request URL's hostname with its internal listener.
 */
export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol =
    request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const host = request.headers.get("host") ?? url.host;
  if (!["http", "https"].includes(protocol) || /[\s/?#@\\%]/.test(host))
    throw new AuthError(403, "Same-origin request required.");
  try {
    const external = new URL(`${protocol}://${host}`);
    if (!external.host || external.username || external.password)
      throw new Error("Invalid request host");
    return external.origin;
  } catch {
    throw new AuthError(403, "Same-origin request required.");
  }
}

/** Rejects cross-origin cookie mutations, including login and logout requests. */
export function assertSameOrigin(request: Request) {
  if (
    request.headers.get("origin") !== requestOrigin(request) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AuthError(403, "Same-origin request required.");
}

/** Returns account errors as private, non-cacheable JSON while leaving unknown errors to the caller. */
export function authErrorResponse(error: unknown) {
  if (error instanceof ZodError || error instanceof SyntaxError)
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  return error instanceof AuthError || error instanceof AuthInputError
    ? Response.json(
        { error: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      )
    : undefined;
}

/** Sets the opaque session as an HTTP-only cookie, secured when the external request uses HTTPS. */
export function sessionResponse(request: Request, session: ConsoleSession) {
  const response = NextResponse.json(
    { user: session.user },
    { headers: { "Cache-Control": "no-store" } },
  );
  setSessionCookie(response, request, session);
  return response;
}

/** Attaches the same opaque session cookie to JSON responses and OIDC redirects. */
export function setSessionCookie(
  response: NextResponse,
  request: Request,
  session: ConsoleSession,
) {
  response.cookies.set(sessionCookieName, session.token, {
    httpOnly: true,
    secure:
      new URL(request.url).protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
  response.cookies.set(contextCookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Returns a safe storage-failure response without exposing credentials or database details. */
export function authenticationUnavailable(error: unknown) {
  return (
    authErrorResponse(error) ??
    Response.json(
      { error: "Account storage unavailable. Try again shortly." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  );
}
