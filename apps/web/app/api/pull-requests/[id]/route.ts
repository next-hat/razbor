import { publicIdSchema } from "@razbor/contracts";
import { getPullRequest, submitReview } from "@razbor/database";

import { canManageResource } from "@web/lib/auth.js";
import {
  assertSameOrigin,
  AuthError,
  authErrorResponse,
  requireApiUser,
  requestSessionToken,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Queues a review of the saved PR revision using current repository grants and server-resolved source metadata. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiUser(request);
    assertSameOrigin(request);
    const input = await managementJson(request);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length
    )
      throw new AuthError(400, "Send an empty review request.");
    const { id } = await params;
    if (!publicIdSchema("pullRequest").safeParse(id).success)
      throw new AuthError(404, "Pull request not found.");
    const database = await reviewDatabase();
    const pr = await getPullRequest(database, id, user.repositoryIds);
    if (!pr) throw new AuthError(404, "Pull request not found.");
    const accepted = await submitReview(
      database,
      {
        repositoryId: pr.repositoryId,
        baseSha: pr.baseSha,
        headSha: pr.headSha,
      },
      requestSessionToken(request),
      user.context.id,
      id,
    );
    return Response.json(accepted, {
      status: 202,
      headers: { "Cache-Control": "no-store", Location: accepted.statusUrl },
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        {
          error:
            "Could not request this review. Check repository readiness and try again.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      )
    );
  }
}

/** Resolves a stable public PR identity within the requesting account's repository grants. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await context.params;
    if (!publicIdSchema("pullRequest").safeParse(id).success)
      return Response.json(
        { error: "Pull request not found" },
        { status: 404 },
      );
    const isAdmin = canManageResource(user, "repository");
    const pr = await getPullRequest(
      await reviewDatabase(),
      id,
      user.repositoryIds,
    );
    return pr
      ? Response.json(visiblePullRequest(pr, isAdmin), {
          headers: { "Cache-Control": "no-store" },
        })
      : Response.json({ error: "Pull request not found" }, { status: 404 });
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
