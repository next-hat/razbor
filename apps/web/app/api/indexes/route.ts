import { publicIdSchema } from "@razbor/contracts";

import { apiAccessResponse } from "@web/lib/request-access.js";
import { reviewDatabase } from "@web/lib/review.js";
import { indexData } from "@web/lib/page-data.js";
import { authErrorResponse, requireApiUser } from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Returns current index and token views, optionally scoped to a validated repository
 * ID.
 */
export async function GET(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "indexer" });
  if (denied) return denied;
  const repositoryId =
    new URL(request.url).searchParams.get("repositoryId") ?? undefined;
  if (
    repositoryId &&
    !publicIdSchema("repository").safeParse(repositoryId).success
  )
    return Response.json({ error: "Invalid repository ID" }, { status: 400 });
  try {
    const database = await reviewDatabase();
    const user = await requireApiUser(request, {
      resource: "indexer",
      repositoryId,
    });
    return Response.json(
      await indexData(
        database,
        repositoryId,
        user.repositoryIds,
        user.context.id,
      ),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      { error: "Indexer data unavailable" },
      { status: 503 },
    );
  }
}
