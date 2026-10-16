import { publicIdSchema } from "@razbor/contracts";
import {
  getRepositoryGuidance,
  SkillInputError,
  updateRepositoryGuidance,
} from "@razbor/database/skills";

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

/** Reads repository instruction switches and selected managed skills. */
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
    const guidance = await getRepositoryGuidance(
      await reviewDatabase(),
      id,
      await requestContextId(_request),
    );
    return guidance
      ? Response.json(guidance, { headers })
      : Response.json(
          { error: "Repository not found" },
          { status: 404, headers },
        );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Repository guidance is unavailable. Try again." },
      { status: 503, headers },
    );
  }
}

/** Saves guidance settings for subsequently queued reviews from same-origin JSON. */
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
    input = await managementJson(request, 16384);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 16 KiB." },
      { status: 400, headers },
    );
  }
  try {
    const guidance = await updateRepositoryGuidance(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return guidance
      ? Response.json(guidance, { headers })
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
          error instanceof SkillInputError
            ? error.message
            : "Could not update repository guidance. Try again.",
      },
      {
        status: error instanceof SkillInputError ? error.status : 503,
        headers,
      },
    );
  }
}
