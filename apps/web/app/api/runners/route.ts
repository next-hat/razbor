import { createRunner, RunnerInputError } from "@razbor/database";

import { apiAccessResponse } from "@web/lib/request-access.js";
import { authErrorResponse, requestSessionToken } from "@web/lib/auth.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";
import { runnerData } from "@web/lib/runners.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Returns runner status and repository choices in an uncached management snapshot. */
export async function GET(request: Request) {
  const denied = await apiAccessResponse(request, { admin: true });
  if (denied) return denied;
  try {
    return Response.json(await runnerData(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Runner storage is unavailable. Try again." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * Registers a runner from bounded same-origin JSON and returns its one-time enrollment
 * response without caching.
 */
export async function POST(request: Request) {
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
    return Response.json(
      await createRunner(
        await reviewDatabase(),
        input,
        requestSessionToken(request),
      ),
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      {
        error:
          error instanceof RunnerInputError
            ? error.message
            : "Could not register the runner. Try again.",
      },
      {
        status: error instanceof RunnerInputError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
