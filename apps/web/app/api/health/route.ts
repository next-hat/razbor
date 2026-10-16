import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/**
 * Reports database readiness without disclosing connection failures; unavailable
 * storage produces HTTP 503.
 */
export async function GET() {
  try {
    await reviewDatabase();
    return Response.json({ status: "ready" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
