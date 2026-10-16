import { memoryOperationSchema, publicIdSchema } from "@razbor/contracts";
import { MemoryError, memoryOperation } from "@razbor/database/memory";

import { authErrorResponse } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** Validates repository scope and performs a memory operation with human provenance. */
async function operate(request: Request, id: string, input: unknown) {
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json(
      { error: "Invalid repository ID" },
      { status: 400, headers },
    );
  const parsed = memoryOperationSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid memory request" },
      { status: 400, headers },
    );
  try {
    return Response.json(
      await memoryOperation(
        await reviewDatabase(),
        id,
        parsed.data,
        {
          actor: "human",
        },
        {
          contextId: await requestContextId(request),
          sessionToken: requestSessionToken(request),
        },
      ),
      { headers },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          error instanceof MemoryError
            ? error.message
            : "Memory is unavailable. Try again.",
        ...(error instanceof MemoryError && error.current
          ? { current: error.current }
          : {}),
      },
      { status: error instanceof MemoryError ? error.status : 503, headers },
    );
  }
}

/** Lists or searches visible collections without caching the memory snapshot. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const query = search.get("query")?.trim();
  const includeDeleted = search.get("includeDeleted");
  if (includeDeleted !== null && !["true", "false"].includes(includeDeleted))
    return Response.json(
      { error: "includeDeleted must be true or false" },
      { status: 400, headers },
    );
  return operate(request, id, {
    ...(query
      ? { operation: "search", query }
      : { operation: "list", includeDeleted: includeDeleted === "true" }),
    ...(search.has("collectionId")
      ? { collectionId: search.get("collectionId") }
      : {}),
    ...(search.has("pathPrefix")
      ? { pathPrefix: search.get("pathPrefix") }
      : {}),
    ...(search.has("limit") ? { limit: Number(search.get("limit")) } : {}),
    ...(search.has("offset") ? { offset: Number(search.get("offset")) } : {}),
  });
}

/** Applies a bounded same-origin memory request, preserving version conflict details. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403, headers },
    );
  const { id } = await params;
  let input: unknown;
  try {
    // An edit can contain two 64 KiB strings, each expanded by JSON escaping.
    input = await managementJson(request, 1024 * 1024);
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Provide a valid JSON memory request under 1 MiB." },
      { status: 400, headers },
    );
  }
  return operate(request, id, input);
}
