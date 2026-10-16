import { publicIdSchema } from "@razbor/contracts";
import { updateRunner, RunnerInputError } from "@razbor/database";

import { apiAccessResponse } from "@web/lib/request-access.js";
import { authErrorResponse, requestSessionToken } from "@web/lib/auth.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Updates runner settings or lifecycle state from bounded management JSON, preserving
 * expected validation and state conflicts.
 */
export async function PATCH(
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
  let input: unknown;
  try {
    input = await managementJson(request, 16384);
  } catch {
    return Response.json(
      { error: "Provide a JSON request no larger than 16 KiB." },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  try {
    const runner = await updateRunner(
      await reviewDatabase(),
      id,
      input,
      requestSessionToken(request),
    );
    return runner
      ? Response.json(runner, { headers: { "Cache-Control": "no-store" } })
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
            : "Could not update the runner. Try again.",
      },
      {
        status: error instanceof RunnerInputError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
