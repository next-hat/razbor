import { publicIdSchema } from "@razbor/contracts";
import {
  webhookView,
  saveWebhookFromUi,
  reconcileWebhook,
} from "@razbor/database";

import { authErrorResponse } from "@web/lib/auth.js";
import { apiAccessResponse } from "@web/lib/request-access.js";
import { requestContextId, requestSessionToken } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Returns the repository webhook view after public-ID validation, mapping storage
 * failures to HTTP 503.
 */
export async function GET(_: Request, { params }: Context) {
  const denied = await apiAccessResponse(_, { resource: "repository" });
  if (denied) return denied;
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "Invalid repository ID" }, { status: 400 });
  try {
    return Response.json(await webhookView(await reviewDatabase(), id));
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      { error: "Webhook storage unavailable" },
      { status: 503 },
    );
  }
}

/**
 * Saves UI webhook settings or retries remote reconciliation after validating origin,
 * content type, and settings size.
 */
export async function POST(request: Request, { params }: Context) {
  const denied = await apiAccessResponse(request, { resource: "repository" });
  if (denied) return denied;
  const { id } = await params;
  // Private loopback management plus same-origin requests; public delivery uses
  // the separate ingress process and cannot reach these administrative routes.
  if (
    ![
      `http://${request.headers.get("host")}`,
      `https://${request.headers.get("host")}`,
    ].includes(request.headers.get("origin") ?? "") ||
    request.headers.get("content-type") !== "application/json"
  )
    return Response.json(
      { error: "Same-origin JSON request required" },
      { status: 403 },
    );
  if (!publicIdSchema("repository").safeParse(id).success)
    return Response.json({ error: "Invalid repository ID" }, { status: 400 });
  try {
    const text = await request.text();
    if (text.length > 8192)
      return Response.json({ error: "Settings too large" }, { status: 413 });
    const input = JSON.parse(text);
    const db = await reviewDatabase();
    return Response.json(
      input.action === "reconcile"
        ? { webhook: await reconcileWebhook(db, id) }
        : await saveWebhookFromUi(
            db,
            id,
            input,
            await requestContextId(request),
            requestSessionToken(request),
          ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authorizationError = authErrorResponse(error);
    if (authorizationError) return authorizationError;

    return Response.json(
      {
        error:
          "Unable to save. Check configuration ownership, callback URL, permitted senders and protected secret storage.",
      },
      { status: 400 },
    );
  }
}
