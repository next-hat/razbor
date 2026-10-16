import { AgentInputError, createAgent, listAgents } from "@razbor/database";

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

/**
 * Returns public reviewer profiles without stored API keys; storage failures return an
 * uncached 503 response.
 */
export async function GET(request: Request) {
  const selectionOnly =
    new URL(request.url).searchParams.get("selection") === "repository";
  const denied = await apiAccessResponse(request, {
    resource: selectionOnly ? "repository" : "agent",
  });
  if (denied) return denied;
  try {
    return Response.json(
      await listAgents(await reviewDatabase(), await requestContextId(request)),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Agent storage is unavailable. Try again." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * Creates a reviewer from bounded same-origin JSON and returns its public profile,
 * preserving expected validation errors.
 */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "agent" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  let input: unknown;
  try {
    input = await managementJson(request, 16384);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 16 KiB." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    return Response.json(
      await createAgent(
        await reviewDatabase(),
        input,
        await requestContextId(request),
        requestSessionToken(request),
      ),
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof AgentInputError
            ? error.message
            : "Could not save the agent. Try again.",
      },
      {
        status: error instanceof AgentInputError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
