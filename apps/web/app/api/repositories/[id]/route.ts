import { publicIdSchema } from "@razbor/contracts";
import {
  getRepository,
  replaceRepositoryToken,
  requestRepositoryDeletion,
  RepositoryManagementError,
  reconcileWebhook,
  updateRepositoryCodebaseMemory,
} from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import {
  apiAccessResponse,
  sanitizeRepositoryView,
} from "@web/lib/request-access.js";
import { authErrorResponse, requireApiUser } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import {
  managementRequest,
  managementJson,
} from "@web/lib/management-request.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Returns the public repository view, distinguishing invalid IDs, missing records, and
 * storage outages.
 */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "invalid repository ID" }, { status: 400 });
  try {
    const user = await requireApiUser(request, { repositoryId: id });
    const repository = await getRepository(
      await reviewDatabase(),
      id,
      await requestContextId(request),
    );
    return repository
      ? Response.json(
          canManageResource(user, "repository")
            ? repository
            : sanitizeRepositoryView(repository),
          { headers: { "Cache-Control": "no-store" } },
        )
      : Response.json({ error: "repository not found" }, { status: 404 });
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      { error: "repository storage unavailable" },
      { status: 503 },
    );
  }
}

/**
 * Applies repository mutations in the authenticated context and reconciles
 * the webhook when its access credentials change.
 */
async function change(
  request: Request,
  { params }: Context,
  operation: "delete" | "update",
) {
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "invalid repository ID" }, { status: 400 });
  try {
    const database = await reviewDatabase();
    const input = await managementJson(request);
    const mutate =
      operation === "delete"
        ? requestRepositoryDeletion
        : input && typeof input === "object" && "codebaseMemoryEnabled" in input
          ? updateRepositoryCodebaseMemory
          : replaceRepositoryToken;
    const result = await mutate(
      database,
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    if (mutate === replaceRepositoryToken && result?.status === "active")
      await reconcileWebhook(database, id);
    return Response.json(result, {
      status: operation === "delete" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof RepositoryManagementError
            ? error.message
            : "Could not update this repository. Check the submitted information and try again.",
      },
      {
        status: error instanceof RepositoryManagementError ? error.status : 400,
      },
    );
  }
}

/**
 * Requests durable repository deletion through the shared mutation boundary and returns
 * its accepted state.
 */
export async function DELETE(request: Request, context: Context) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  return change(request, context, "delete");
}

/** Updates repository indexing preferences or replaces access credentials. */
export async function PATCH(request: Request, context: Context) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  return change(request, context, "update");
}
