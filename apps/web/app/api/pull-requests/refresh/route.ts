import { syncPullRequests } from "@razbor/database";

import {
  assertSameOrigin,
  authErrorResponse,
  requireApiUser,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

/** Refreshes only server-authorized repositories after enforcing the cookie mutation origin boundary. */
export async function POST(request: Request) {
  try {
    const user = await requireApiUser(request);
    assertSameOrigin(request);
    const result = await syncPullRequests(
      await reviewDatabase(),
      user.repositoryIds,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: "Pull request refresh unavailable" },
        { status: 503 },
      )
    );
  }
}
