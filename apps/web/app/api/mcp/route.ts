import {
  createMcpServer,
  listMcpServers,
  McpInputError,
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

/** Lists registered HTTP servers without returning their saved credentials. */
export async function GET(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "mcp" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  try {
    return Response.json(
      await listMcpServers(
        await reviewDatabase(),
        await requestContextId(request),
      ),
      {
        headers,
      },
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

/** Registers an existing HTTP MCP endpoint from bounded same-origin JSON. */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "mcp" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
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
    return Response.json(
      await createMcpServer(
        await reviewDatabase(),
        input,
        await requestContextId(request),
        requestSessionToken(request),
      ),
      {
        status: 201,
        headers,
      },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof McpInputError
            ? error.message
            : "Could not save the MCP server. Try again.",
      },
      { status: error instanceof McpInputError ? error.status : 503, headers },
    );
  }
}
