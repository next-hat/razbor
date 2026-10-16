import {
  removeOrganizationMember,
  updateOrganizationMember,
} from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiAccount,
  requestSessionToken,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Changes a current member's organization role after transactional administrator authorization. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id, userId } = await params;
    const member = await updateOrganizationMember(
      await reviewDatabase(),
      id,
      userId,
      await managementJson(request, 65536),
      requestSessionToken(request),
    );
    return Response.json(member, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}

/** Removes organization membership and all repository grants belonging to that membership. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id, userId } = await params;
    await removeOrganizationMember(
      await reviewDatabase(),
      id,
      userId,
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
