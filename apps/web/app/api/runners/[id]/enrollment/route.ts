import { publicIdSchema } from "@razbor/contracts";
import { rotateRunnerEnrollment, RunnerInputError } from "@razbor/database";

import { apiAccessResponse } from "@web/lib/request-access.js";
import { authErrorResponse, requestSessionToken } from "@web/lib/auth.js";
import { managementRequest } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Rotates a runner enrollment grant after request validation and returns its one-time
 * token with caching disabled.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { admin: true });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      },
    );
  const { id } = await params;
  if (!publicIdSchema("runner").safeParse(id).success)
    return Response.json(
      { error: "Invalid runner ID" },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  try {
    const enrollment = await rotateRunnerEnrollment(
      await reviewDatabase(),
      id,
      requestSessionToken(request),
    );
    return enrollment
      ? Response.json(enrollment, { headers: { "Cache-Control": "no-store" } })
      : Response.json(
          { error: "Runner not found" },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      {
        error:
          error instanceof RunnerInputError
            ? error.message
            : "Could not renew enrollment. Try again.",
      },
      {
        status: error instanceof RunnerInputError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
