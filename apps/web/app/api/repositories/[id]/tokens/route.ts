import { publicIdSchema } from "@razbor/contracts";
import { createIndexToken } from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import {
  managementRequest,
  managementJson,
} from "@web/lib/management-request.js";
import { provisionIndex } from "@web/lib/indexer.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

/**
 * Provisions a repository workspace before issuing a token with the requested refresh
 * permission; the returned secret is not cacheable.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "indexer" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "Invalid repository ID" }, { status: 400 });
  try {
    const input = await managementJson(request, 1024);
    if (
      !input ||
      typeof input !== "object" ||
      !("refresh" in input) ||
      typeof input.refresh !== "boolean" ||
      Object.keys(input).some((key) => key !== "refresh")
    )
      return Response.json(
        { error: "A refresh permission is required" },
        { status: 400 },
      );
    const workspaceId = await provisionIndex(id, false, request.signal);
    const token = await createIndexToken(
      await reviewDatabase(),
      workspaceId,
      input.refresh,
      undefined,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return Response.json(
      { ...token, expiresAt: null },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          "Could not generate a token. Check that the indexer is running and configured for this repository.",
      },
      { status: 503 },
    );
  }
}
