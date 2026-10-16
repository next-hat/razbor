import { publicIdSchema } from "@razbor/contracts";
import {
  deleteMcpServer,
  getMcpServer,
  McpInputError,
  updateMcpServer,
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

/** Reads redacted server settings, distinguishing invalid and missing identifiers. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(_request, { resource: "mcp" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  const { id } = await params;
  if (!publicIdSchema("mcpServer").safeParse(id).success)
    return Response.json(
      { error: "Invalid MCP server ID" },
      { status: 400, headers },
    );
  try {
    const server = await getMcpServer(
      await reviewDatabase(),
      id,
      await requestContextId(_request),
    );
    return server
      ? Response.json(server, { headers })
      : Response.json(
          { error: "MCP server not found" },
          { status: 404, headers },
        );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "MCP server storage is unavailable. Try again." },
      { status: 503, headers },
    );
  }
}

/** Updates an HTTP registration; omitted credentials retain the saved token. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "mcp" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  const { id } = await params;
  if (!publicIdSchema("mcpServer").safeParse(id).success)
    return Response.json(
      { error: "Invalid MCP server ID" },
      { status: 400, headers },
    );
  let input: unknown;
  try {
    input = await managementJson(request, 64 * 1024);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 64 KiB." },
      { status: 400, headers },
    );
  }
  try {
    const server = await updateMcpServer(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return server
      ? Response.json(server, { headers })
      : Response.json(
          { error: "MCP server not found" },
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
            : "Could not update the MCP server. Try again.",
      },
      { status: error instanceof McpInputError ? error.status : 503, headers },
    );
  }
}

/** Deletes a registration and its grants after checking the same-origin request. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "mcp" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  const { id } = await params;
  if (!publicIdSchema("mcpServer").safeParse(id).success)
    return Response.json(
      { error: "Invalid MCP server ID" },
      { status: 400, headers },
    );
  try {
    return (await deleteMcpServer(
      await reviewDatabase(),
      id,
      await requestContextId(request),
      requestSessionToken(request),
    ))
      ? new Response(null, { status: 204, headers })
      : Response.json(
          { error: "MCP server not found" },
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
            : "Could not delete the MCP server. Try again.",
      },
      { status: error instanceof McpInputError ? error.status : 503, headers },
    );
  }
}
