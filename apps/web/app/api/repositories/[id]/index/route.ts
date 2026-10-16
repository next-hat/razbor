import { publicIdSchema } from "@razbor/contracts";

import { authErrorResponse } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { managementRequest } from "@web/lib/management-request.js";
import { provisionIndex } from "@web/lib/indexer.js";

export const runtime = "nodejs";

const indexFailure =
  "Unable to start indexing. Check the indexer connection and repository configuration, then retry.";

/**
 * Starts preparation for a validated, authorized repository. The indexer owns the
 * accepted operation, so leaving or reloading the page does not cancel its work.
 */
export async function POST(
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
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "Invalid repository ID" }, { status: 400 });
  try {
    const workspaceId = await provisionIndex(id, true, request.signal, true);
    return Response.json(
      { workspaceId },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error: indexFailure,
      },
      { status: 503 },
    );
  }
}
