import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { createIndexToken } from "@razbor/database";

import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import {
  managementRequest,
  managementJson,
} from "@web/lib/management-request.js";
import { provisionIndex } from "@web/lib/indexer.js";
import { reviewDatabase } from "@web/lib/review.js";
import {
  AuthError,
  authErrorResponse,
  canAccessRepository,
  requireApiUser,
} from "@web/lib/auth.js";

export const runtime = "nodejs";

const inputSchema = z
  .object({
    repositoryIds: z.array(publicIdSchema("repository")).min(1),
    refresh: z.boolean(),
    allRepositories: z.boolean().default(false),
  })
  .strict();

/**
 * Provisions each selected repository index before issuing a scoped token, returning
 * the token secret once with caching disabled.
 */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request, { resource: "indexer" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(await managementJson(request, 65536));
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          "Select at least one repository and a refresh permission. The request must fit within 64 KB.",
      },
      { status: 400 },
    );
  }
  try {
    const user = await requireApiUser(request, { resource: "indexer" });
    if (input.repositoryIds.some((id) => !canAccessRepository(user, id)))
      throw new AuthError(404, "Repository not found.");
    const workspaceIds: string[] = [];
    for (const repositoryId of new Set(input.repositoryIds)) {
      request.signal.throwIfAborted();
      workspaceIds.push(
        await provisionIndex(repositoryId, false, request.signal),
      );
    }
    request.signal.throwIfAborted();
    const token = await createIndexToken(
      await reviewDatabase(),
      workspaceIds,
      input.refresh,
      input.allRepositories,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return Response.json(
      { ...token, expiresAt: null },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      {
        error:
          "Could not generate a token. Check that the indexer is running and configured for every selected repository.",
      },
      { status: 503 },
    );
  }
}
