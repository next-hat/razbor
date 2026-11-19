import { ZodError } from "zod";

import {
  RepositoryManagementError,
  updateRepositoryMergePolicy,
} from "@razbor/database";

import {
  authErrorResponse,
  requestContextId,
  requestSessionToken,
} from "@web/lib/auth.js";
import {
  managementJson,
  managementRequest,
} from "@web/lib/management-request.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

/** Replace privileged settings only in the authenticated repository context and at the editor's saved version. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await apiAccessResponse(request, {
    resource: "repository",
    repositoryId: id,
  });
  if (denied) return denied;
  if (!managementRequest(request))
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  try {
    const input = await managementJson(request, 1024 * 1024);
    const saved = await updateRepositoryMergePolicy(
      await reviewDatabase(),
      id,
      input,
      await requestContextId(request),
      requestSessionToken(request),
    );
    return saved
      ? Response.json(
          { policy: saved.mergePolicy, version: saved.mergePolicyVersion },
          { headers: { "Cache-Control": "no-store" } },
        )
      : Response.json({ error: "Repository not found." }, { status: 404 });
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    if (error instanceof RepositoryManagementError)
      return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return Response.json(
        { error: `${issue.path.join(".")} — ${issue.message}` },
        { status: 400 },
      );
    }
    if (error instanceof SyntaxError)
      return Response.json(
        { error: "A valid JSON object is required." },
        { status: 400 },
      );
    return Response.json(
      { error: "Could not save the merge policy." },
      { status: 503 },
    );
  }
}
