import { publicIdSchema } from "@razbor/contracts";
import { publicationView } from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { reviewWithReadiness } from "@web/lib/review-readiness.js";
import {
  authErrorResponse,
  canAccessRepository,
  requireApiUser,
} from "@web/lib/auth.js";
import { sanitizeReviewView } from "@web/lib/request-access.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Returns review state, runner readiness, and forge publication details, distinguishing
 * invalid or absent reviews from storage failure.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!publicIdSchema("review").safeParse(id).success)
    return Response.json({ error: "invalid review ID" }, { status: 400 });
  try {
    const user = await requireApiUser(request);
    const review = await reviewWithReadiness(await reviewDatabase(), id);
    if (review && !canAccessRepository(user, review.repositoryId))
      return Response.json({ error: "review not found" }, { status: 404 });
    return review
      ? Response.json(
          {
            ...(canManageResource(user, "repository")
              ? review
              : sanitizeReviewView(review)),
            interaction: await publicationView(await reviewDatabase(), id),
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      : Response.json({ error: "review not found" }, { status: 404 });
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      { error: "review storage unavailable" },
      { status: 503 },
    );
  }
}
