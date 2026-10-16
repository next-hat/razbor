import { publicIdSchema } from "@razbor/contracts";
import {
  retryRepositorySetup,
  reconcileWebhook,
  RepositoryManagementError,
} from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { reviewDatabase } from "@web/lib/review.js";
import {
  managementRequest,
  managementJson,
} from "@web/lib/management-request.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Retries repository setup and reconciles its webhook after validating the management
 * request.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "invalid repository ID" }, { status: 400 });
  try {
    await managementJson(request);
    const database = await reviewDatabase();
    const repository = await retryRepositorySetup(
      database,
      id,
      await requestContextId(request),
      requestSessionToken(request),
    );
    await reconcileWebhook(database, id);
    return Response.json(repository, { status: 202 });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof RepositoryManagementError
            ? error.message
            : "Could not retry repository setup.",
      },
      {
        status: error instanceof RepositoryManagementError ? error.status : 400,
      },
    );
  }
}
