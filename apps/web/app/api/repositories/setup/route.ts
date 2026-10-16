import { repositorySetupDefaults } from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Returns current repository setup defaults without caching them, or HTTP 503 when they
 * cannot be loaded.
 */
export async function GET(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  try {
    return Response.json(
      await repositorySetupDefaults(
        await reviewDatabase(),
        await requestContextId(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Repository setup is unavailable." },
      { status: 503 },
    );
  }
}
