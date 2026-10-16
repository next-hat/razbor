import { inviteOrganizationMember } from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiAccount,
  requestSessionToken,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Invites an existing account with explicit role and repository access chosen by an org admin. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id } = await params;
    const result = await inviteOrganizationMember(
      await reviewDatabase(),
      id,
      await managementJson(request, 65536),
      requestSessionToken(request),
    );
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
