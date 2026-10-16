import {
  RepositoryRegistrationError,
  verifyRepositoryFromUi,
} from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId } from "@web/lib/auth.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Verify administrator-supplied forge access without storing credentials or
 * provisioning a webhook. Return only safe repository and bot display fields.
 */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  try {
    const repository = await verifyRepositoryFromUi(
      await managementJson(request),
      await reviewDatabase(),
      await requestContextId(request),
    );
    return Response.json(repository, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof RepositoryRegistrationError
            ? error.message
            : "Could not verify this repository. Check the selected forge, HTTPS URL, instance URL, token, and branch.",
      },
      {
        status:
          error instanceof RepositoryRegistrationError ? error.status : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
