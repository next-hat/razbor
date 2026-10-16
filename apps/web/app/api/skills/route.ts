import {
  createSkill,
  listSkills,
  SkillInputError,
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

/** Lists installed skill metadata without caching mutable management data. */
export async function GET(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "skill" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  try {
    return Response.json(
      await listSkills(await reviewDatabase(), await requestContextId(request)),
      { headers },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Skill storage is unavailable. Try again." },
      { status: 503, headers },
    );
  }
}

/** Installs a validated text bundle from bounded same-origin JSON. */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "skill" });
  if (denied) return denied;
  const headers = { "Cache-Control": "no-store" };
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  let input: unknown;
  try {
    // JSON escaping can expand the validated 1 MiB bundle beyond its content size.
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
    return Response.json(
      await createSkill(
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
          error instanceof SkillInputError
            ? error.message
            : "Could not save the skill. Try again.",
      },
      {
        status: error instanceof SkillInputError ? error.status : 503,
        headers,
      },
    );
  }
}
