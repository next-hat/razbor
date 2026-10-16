import { publicIdSchema } from "@razbor/contracts";
import { getMcpServerConnection } from "@razbor/database/mcp";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { testMcpConnection } from "@web/lib/mcp-connection.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Probes a saved server with bounded tool discovery and sanitized connection errors. */
export async function POST(
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
    await managementJson(request);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 4 KiB." },
      { status: 400, headers },
    );
  }
  let server;
  try {
    server = await getMcpServerConnection(
      await reviewDatabase(),
      id,
      await requestContextId(request),
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "MCP server storage is unavailable. Try again." },
      { status: 503, headers },
    );
  }
  if (!server)
    return Response.json(
      { error: "MCP server not found" },
      { status: 404, headers },
    );
  try {
    return Response.json(await testMcpConnection(server, request.signal), {
      headers,
    });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          "Could not connect to the MCP server. Check its HTTP endpoint and credentials, then try again.",
      },
      { status: 502, headers },
    );
  }
}
