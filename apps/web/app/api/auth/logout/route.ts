import { NextResponse } from "next/server.js";

import { revokeSession } from "@razbor/database";

import {
  assertSameOrigin,
  authenticationDatabase,
  authenticationUnavailable,
  requestSessionToken,
  sessionCookieName,
} from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Revokes the current server session before removing its browser cookie. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const token = requestSessionToken(request);
    if (token) await revokeSession(await authenticationDatabase(), token);
    const response = NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(sessionCookieName, "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
