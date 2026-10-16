import { publicIdSchema } from "@razbor/contracts";
import {
  ReviewEvaluationInputError,
  updateReviewEvaluation,
} from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Saves optional evaluation marks without changing the review result or publication. */
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
  if (!publicIdSchema("review").safeParse(id).success)
    return Response.json(
      { error: "Invalid review ID" },
      { status: 400, headers },
    );
  let input: unknown;
  try {
    input = await managementJson(request);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a JSON request no larger than 4 KiB." },
      { status: 400, headers },
    );
  }
  try {
    const evaluation = await updateReviewEvaluation(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return evaluation
      ? Response.json(evaluation, { headers })
      : Response.json({ error: "Review not found" }, { status: 404, headers });
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof ReviewEvaluationInputError
            ? error.message
            : "Could not update review evaluation. Try again.",
      },
      {
        status:
          error instanceof ReviewEvaluationInputError ? error.status : 503,
        headers,
      },
    );
  }
}
