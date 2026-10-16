import { respondToInvitation } from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiAccount,
  requestSessionToken,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Accepts only the signed-in account's pending invitation and its explicitly selected grants. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id } = await params;
    const result = await respondToInvitation(
      await reviewDatabase(),
      id,
      "accept",
      requestSessionToken(request),
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
