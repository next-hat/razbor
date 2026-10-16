import { publicIdSchema } from "@razbor/contracts";
import { revokeToken } from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { managementRequest } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

/**
 * Revokes the identified index token after validating the browser request and public
 * token ID.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "indexer" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  const { id } = await params;
  if (!publicIdSchema("token").safeParse(id).success)
    return Response.json({ error: "Invalid token ID" }, { status: 400 });
  try {
    await revokeToken(
      await reviewDatabase(),
      id,
      undefined,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json({ error: "Token unavailable" }, { status: 400 });
  }
}
