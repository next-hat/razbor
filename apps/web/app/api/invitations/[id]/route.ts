import { respondToInvitation } from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiAccount,
  requestSessionToken,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Rejects a pending invitation addressed to the current signed-in account. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id } = await params;
    await respondToInvitation(
      await reviewDatabase(),
      id,
      "reject",
      requestSessionToken(request),
    );
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
