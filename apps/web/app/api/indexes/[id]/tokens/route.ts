import { publicIdSchema } from "@razbor/contracts";
import { createIndexToken } from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { managementRequest } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

/**
 * Issues a token for an existing persistent workspace with an explicit refresh
 * permission and a bounded request body.
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
  if (!publicIdSchema("workspace").safeParse(id).success)
    return Response.json({ error: "Invalid index ID" }, { status: 400 });
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Invalid index token request");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024) {
        await reader.cancel();
        return Response.json({ error: "Request too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !input ||
      typeof input.refresh !== "boolean" ||
      Object.keys(input).some((key) => key !== "refresh")
    )
      return Response.json(
        { error: "A refresh permission is required" },
        { status: 400 },
      );
    const token = await createIndexToken(
      await reviewDatabase(),
      id,
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
          "Could not create a token. A provisioned persistent index is required.",
      },
      { status: 400 },
    );
  }
}
