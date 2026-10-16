import { listReviews } from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { authErrorResponse, requireApiUser } from "@web/lib/auth.js";
import { sanitizeReviewView } from "@web/lib/request-access.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Returns the latest review views or HTTP 503 when review storage is unavailable. */
export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const reviews = await listReviews(
      await reviewDatabase(),
      undefined,
      user.repositoryIds,
    );
    return Response.json(
      canManageResource(user, "repository")
        ? reviews
        : reviews.map(sanitizeReviewView),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      { error: "review storage unavailable" },
      { status: 503 },
    );
  }
}
