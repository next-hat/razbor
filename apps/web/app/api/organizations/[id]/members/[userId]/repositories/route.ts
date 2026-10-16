import { z } from "zod";

import { publicIdSchema } from "@razbor/contracts";
import { updateOrganizationMember } from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  requireApiAccount,
  requestSessionToken,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

/** Replaces an ordinary member's direct repository grants without permitting role changes. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const { id, userId } = await params;
    const input = z
      .object({
        repositoryIds: z.array(publicIdSchema("repository")).max(1000),
      })
      .strict()
      .parse(await managementJson(request, 65536));
    const member = await updateOrganizationMember(
      await reviewDatabase(),
      id,
      userId,
      input,
      requestSessionToken(request),
    );
    return Response.json(member, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
