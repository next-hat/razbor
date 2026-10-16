import { NextResponse } from "next/server.js";
import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { getAccountContext } from "@razbor/database";

import {
  assertSameOrigin,
  AuthError,
  authenticationUnavailable,
  contextCookieName,
  requireApiAccount,
  requestOrigin,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Validates current membership before selecting a personal or organization context. */
export async function POST(request: Request) {
  try {
    const user = await requireApiAccount(request);
    assertSameOrigin(request);
    const input = z
      .object({ contextId: publicIdSchema("context") })
      .strict()
      .parse(await managementJson(request));
    const context = await getAccountContext(
      await reviewDatabase(),
      input.contextId,
      user,
    );
    if (!context) throw new AuthError(404, "Account context not found.");
    const response = NextResponse.json(
      { context },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(contextCookieName, context.id, {
      httpOnly: true,
      secure: new URL(requestOrigin(request)).protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 31536000,
    });
    return response;
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
