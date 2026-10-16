import { publicIdSchema } from "@razbor/contracts";
import {
  getRepositoryMcpAccess,
  McpInputError,
  updateRepositoryMcpAccess,
} from "@razbor/database/mcp";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Reads the repository's explicit server grants without exposing credentials. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(_request, { resource: "repository" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json(
      { error: "Invalid repository ID" },
      { status: 400, headers },
    );
  try {
    const access = await getRepositoryMcpAccess(
      await reviewDatabase(),
      id,
      await requestContextId(_request),
    );
    return access
      ? Response.json(access, { headers })
      : Response.json(
          { error: "Repository not found" },
          { status: 404, headers },
        );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Repository MCP access is unavailable. Try again." },
      { status: 503, headers },
    );
  }
}

/** Replaces the selected servers from bounded same-origin management JSON. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json(
      { error: "Invalid repository ID" },
      { status: 400, headers },
    );
  let input: unknown;
  try {
    input = await managementJson(request, 4096);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 4 KiB." },
      { status: 400, headers },
    );
  }
  try {
    const access = await updateRepositoryMcpAccess(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return access
      ? Response.json(access, { headers })
      : Response.json(
          { error: "Repository not found" },
          { status: 404, headers },
        );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof McpInputError
            ? error.message
            : "Could not update repository MCP access. Try again.",
      },
      { status: error instanceof McpInputError ? error.status : 503, headers },
    );
  }
}
