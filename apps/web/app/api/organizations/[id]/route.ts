import {
  getAccountContext,
  listOrganizationMembers,
  listOrganizationInvitations,
  listRepositories,
} from "@razbor/database";

import {
  AuthError,
  authenticationUnavailable,
  requireApiAccount,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

export const dynamic = "force-dynamic";

/** Returns organization membership and repository choices to administrators and access moderators. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiAccount(request);
    const { id } = await params;
    const database = await reviewDatabase();
    const context = await getAccountContext(database, id, user);
    if (
      !context ||
      context.kind !== "organization" ||
      (user.role !== "super_admin" &&
        !["admin", "moderator"].includes(context.role))
    )
      throw new AuthError(404, "Organization not found.");
    return Response.json(
      {
        members: await listOrganizationMembers(database, id, user),
        invitations:
          user.role === "super_admin" || context.role === "admin"
            ? await listOrganizationInvitations(database, id, user)
            : [],
        repositories: await listRepositories(database, undefined, id),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
