import { publicIdSchema } from "@razbor/contracts";
import {
  deleteSkill,
  getSkill,
  SkillInputError,
  updateSkill,
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

/** Reads the current skill bundle, distinguishing invalid and missing identifiers. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(_request, { resource: "skill" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  const { id } = await params;
  if (!publicIdSchema("skill").safeParse(id).success)
    return Response.json(
      { error: "Invalid skill ID" },
      { status: 400, headers },
    );
  try {
    const skill = await getSkill(
      await reviewDatabase(),
      id,
      await requestContextId(_request),
    );
    return skill
      ? Response.json(skill, { headers })
      : Response.json({ error: "Skill not found" }, { status: 404, headers });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Skill storage is unavailable. Try again." },
      { status: 503, headers },
    );
  }
}

/** Replaces the bundle from bounded same-origin JSON while retaining queued snapshots. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "skill" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  const { id } = await params;
  if (!publicIdSchema("skill").safeParse(id).success)
    return Response.json(
      { error: "Invalid skill ID" },
      { status: 400, headers },
    );
  let input: unknown;
  try {
    input = await managementJson(request, 8 * 1024 * 1024);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 8 MiB." },
      { status: 400, headers },
    );
  }
  try {
    const skill = await updateSkill(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return skill
      ? Response.json(skill, { headers })
      : Response.json({ error: "Skill not found" }, { status: 404, headers });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof SkillInputError
            ? error.message
            : "Could not update the skill. Try again.",
      },
      {
        status: error instanceof SkillInputError ? error.status : 503,
        headers,
      },
    );
  }
}

/** Deletes an unassigned skill after validating the same-origin management request. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "skill" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  const { id } = await params;
  if (!publicIdSchema("skill").safeParse(id).success)
    return Response.json(
      { error: "Invalid skill ID" },
      { status: 400, headers },
    );
  try {
    return (await deleteSkill(
      await reviewDatabase(),
      id,
      await requestContextId(request),
      requestSessionToken(request),
    ))
      ? new Response(null, { status: 204, headers })
      : Response.json({ error: "Skill not found" }, { status: 404, headers });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof SkillInputError
            ? error.message
            : "Could not delete the skill. Try again.",
      },
      {
        status: error instanceof SkillInputError ? error.status : 503,
        headers,
      },
    );
  }
}
