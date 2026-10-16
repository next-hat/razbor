import { publicIdSchema } from "@razbor/contracts";
import { listReviews } from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { authErrorResponse, requireApiUser } from "@web/lib/auth.js";
import { sanitizeReviewView } from "@web/lib/request-access.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Returns the review history for a validated repository ID without caching the
 * snapshot.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "Invalid repository ID" }, { status: 400 });
  try {
    const user = await requireApiUser(request, { repositoryId: id });
    const reviews = await listReviews(await reviewDatabase(), id);
    return Response.json(
      canManageResource(user, "repository")
        ? reviews
        : reviews.map(sanitizeReviewView),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json({ error: "Reviews unavailable" }, { status: 503 });
  }
}
