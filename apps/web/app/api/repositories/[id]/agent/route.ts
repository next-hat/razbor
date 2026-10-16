import { publicIdSchema } from "@razbor/contracts";
import { AgentInputError, assignRepositoryAgent } from "@razbor/database";

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
 * Assigns a reviewer or the runner default from same-origin JSON, retaining explicit
 * validation and assignment conflicts.
 */
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
  let agentId: string | null;
  try {
    const input: unknown = await managementJson(request);
    if (!input || typeof input !== "object" || !("agentId" in input))
      throw new Error("Missing agent ID");
    if (
      input.agentId !== null &&
      !publicIdSchema("agent").safeParse(input.agentId).success
    )
      throw new Error("Invalid agent ID");
    agentId = input.agentId as string | null;
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide an agent ID, or null to use the runner default." },
      { status: 400, headers },
    );
  }
  try {
    const repository = await assignRepositoryAgent(
      await reviewDatabase(),
      id,
      agentId,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return repository
      ? Response.json(repository, { headers })
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
          error instanceof AgentInputError
            ? error.message
            : "Could not update the AI reviewer. Try again.",
      },
      {
        status: error instanceof AgentInputError ? error.status : 503,
        headers,
      },
    );
  }
}
