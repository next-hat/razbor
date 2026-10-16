import { publicIdSchema } from "@razbor/contracts";
import { AgentInputError, deleteAgent, updateAgent } from "@razbor/database";

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
 * Updates a reviewer from bounded same-origin JSON, returning only its public view and
 * distinguishing missing profiles from validation failures.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "agent" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  const { id } = await params;
  if (!publicIdSchema("agent").safeParse(id).success)
    return Response.json(
      { error: "Invalid agent ID" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
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
    const agent = await updateAgent(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return agent
      ? Response.json(agent, { headers: { "Cache-Control": "no-store" } })
      : Response.json(
          { error: "Agent not found" },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof AgentInputError
            ? error.message
            : "Could not update the agent. Try again.",
      },
      {
        status: error instanceof AgentInputError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

/**
 * Deletes an unused reviewer after request and ID validation, preserving conflicts
 * caused by repository assignments or active reviews.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "agent" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  const { id } = await params;
  if (!publicIdSchema("agent").safeParse(id).success)
    return Response.json(
      { error: "Invalid agent ID" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  try {
    return (await deleteAgent(
      await reviewDatabase(),
      id,
      await requestContextId(request),
      requestSessionToken(request),
    ))
      ? new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        })
      : Response.json(
          { error: "Agent not found" },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof AgentInputError
            ? error.message
            : "Could not delete the agent. Try again.",
      },
      {
        status: error instanceof AgentInputError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
