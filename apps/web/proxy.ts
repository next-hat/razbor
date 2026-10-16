import { NextResponse, type NextRequest } from "next/server.js";

import {
  assertSameOrigin,
  authenticationUnavailable,
  readRequestUser,
  requestOrigin,
} from "@web/lib/auth.js";

/** Resolves legacy console API aliases before applying the same access policy as their route handlers. */
function consolePath(pathname: string) {
  if (/^\/(?:health|review|reviews|repositories)(?:\/|$)/.test(pathname))
    return `/api${pathname}`;
  return pathname;
}

/**
 * Gates console pages and APIs with live account state while retaining signed
 * webhook callbacks, runner machine authentication, and database health probes.
 * Scoped route handlers independently verify repository grants before reads.
 */
export async function proxy(request: NextRequest) {
  const pathname = consolePath(request.nextUrl.pathname);
  if (
    pathname === "/api/health" ||
    pathname.startsWith("/webhooks/") ||
    pathname.startsWith("/api/runner/") ||
    [
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/password",
      "/api/auth/oidc/start",
      "/api/auth/oidc/callback",
    ].includes(pathname) ||
    ["/logo.png", "/favicon.ico"].includes(pathname)
  )
    return NextResponse.next();
  try {
    const origin = requestOrigin(request);
    const user = await readRequestUser(request);
    const isApi = pathname.startsWith("/api/");
    if (pathname === "/login") {
      return user
        ? NextResponse.redirect(
            new URL(user.mustChangePassword ? "/change-password" : "/", origin),
          )
        : NextResponse.next();
    }
    if (!user) {
      return isApi
        ? Response.json(
            { error: "Sign in to continue." },
            { status: 401, headers: { "Cache-Control": "no-store" } },
          )
        : NextResponse.redirect(new URL("/login", origin));
    }
    if (pathname === "/change-password") return NextResponse.next();
    if (user.mustChangePassword) {
      return isApi
        ? Response.json(
            { error: "Change your password to continue." },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          )
        : NextResponse.redirect(new URL("/change-password", origin));
    }
    if (isApi && !["GET", "HEAD", "OPTIONS"].includes(request.method))
      assertSameOrigin(request);
    return NextResponse.next();
  } catch (error) {
    return authenticationUnavailable(error);
  }
}

export const config = {
  // Runner routes enforce bearer/capability access themselves. Exclude their existing
  // bypass here to avoid the framework's proxy cloning of machine request bodies.
  matcher: ["/((?!_next/static|_next/image|api/runner/).*)"],
};
