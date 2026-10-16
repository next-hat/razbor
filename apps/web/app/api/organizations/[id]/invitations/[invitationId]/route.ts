import { revokeOrganizationInvitation } from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiAccount,
  requestSessionToken,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Cancels a pending invitation after rechecking organization administration rights. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; invitationId: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id, invitationId } = await params;
    await revokeOrganizationInvitation(
      await reviewDatabase(),
      id,
      invitationId,
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
