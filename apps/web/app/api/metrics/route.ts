import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { getReviewMetrics } from "@razbor/database";

import { reviewDatabase } from "@web/lib/review.js";
import { authErrorResponse, requireApiUser } from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    days: z.enum(["30", "90", "365"]).transform(Number).optional(),
    repositoryId: publicIdSchema("repository").optional(),
    targetKey: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^(?:change:[1-9][0-9]*|branch:.+|revision:.+)$/)
      .optional(),
  })
  .strict()
  .refine(
    (query) => !query.targetKey || !!query.repositoryId,
    "Target filters require a repository",
  );

/**
 * Returns uncached durable metrics for a validated period and repository/target scope;
 * malformed filters return 400 and storage failures return a sanitized 503.
 */
export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const query = querySchema.safeParse(Object.fromEntries(parameters));
  if (
    !query.success ||
    [...parameters.keys()].some((key) => parameters.getAll(key).length > 1)
  )
    return Response.json({ error: "Invalid metrics filters" }, { status: 400 });
  try {
    const user = await requireApiUser(request, {
      repositoryId: query.data.repositoryId,
    });
    return Response.json(
      await getReviewMetrics(await reviewDatabase(), {
        ...query.data,
        days: query.data.days as 30 | 90 | 365 | undefined,
        repositoryIds: user.repositoryIds,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    return Response.json({ error: "Metrics unavailable" }, { status: 503 });
  }
}
