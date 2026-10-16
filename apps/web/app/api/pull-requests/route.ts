import { listPullRequests } from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import { authErrorResponse, requireApiUser } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Returns saved PRs scoped to current grants, omitting administrator-only review configuration. */
export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const isAdmin = canManageResource(user, "repository");
    const prs = await listPullRequests(
      await reviewDatabase(),
      user.repositoryIds,
    );
    return Response.json(
      prs.map((pr) => visiblePullRequest(pr, isAdmin)),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: "Pull request storage unavailable" },
        { status: 503 },
      )
    );
  }
}
