import { reviewRequestSchema } from "@razbor/contracts";
import { SkillInputError, submitReview } from "@razbor/database";

import { apiAccessResponse } from "@web/lib/request-access.js";
import { reviewDatabase } from "@web/lib/review.js";
import {
  authErrorResponse,
  requireApiUser,
  requestSessionToken,
} from "@web/lib/auth.js";

export const runtime = "nodejs";

/**
 * Accepts a bounded manual review request with full commit IDs and returns durable
 * acceptance plus a status URL; cross-origin browser requests are rejected.
 */
export async function POST(request: Request) {
  const denied = await apiAccessResponse(request);
  if (denied) return denied;
  const origin = request.headers.get("origin");
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
    (origin &&
      ![
        `http://${request.headers.get("host")}`,
        `https://${request.headers.get("host")}`,
      ].includes(origin))
  )
    return Response.json(
      { error: "same-origin JSON request required" },
      { status: 403 },
    );
  let input;
  try {
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json({ error: "invalid request" }, { status: 400 });
    let body = "";
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        return Response.json({ error: "request too large" }, { status: 413 });
      }
      body += decoder.decode(value, { stream: true });
    }
    input = reviewRequestSchema.parse(JSON.parse(body + decoder.decode()));
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          "invalid request: repositoryId and full baseSha/headSha required",
      },
      { status: 400 },
    );
  }
  try {
    const user = await requireApiUser(request, {
      repositoryId: input.repositoryId,
    });
    const accepted = await submitReview(
      await reviewDatabase(),
      input,
      requestSessionToken(request),
      user.context.id,
    );
    return Response.json(accepted, {
      status: 202,
      headers: { Location: accepted.statusUrl },
    });
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json(
      {
        error:
          error instanceof SkillInputError
            ? error.message
            : "review storage unavailable or repository not registered and verified",
      },
      { status: error instanceof SkillInputError ? error.status : 503 },
    );
  }
}
