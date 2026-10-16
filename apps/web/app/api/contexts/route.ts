import {
  createOrganization,
  listAccountContexts,
  listAccountInvitations,
} from "@razbor/database";

import {
  assertSameOrigin,
  authenticationUnavailable,
  contextCookieName,
  requireApiAccount,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { requestSessionToken } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";

export const dynamic = "force-dynamic";

/** Lists current accessible owner contexts and invitations independently of a stale selection. */
export async function GET(request: Request) {
  try {
    const user = await requireApiAccount(request);
    const database = await reviewDatabase();
    const contexts = await listAccountContexts(database, user);
    const selections = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${contextCookieName}=`));
    const selected =
      selections.length === 1
        ? selections[0]!.slice(contextCookieName.length + 1)
        : undefined;
    const currentContext = selected
      ? contexts.find((context) => context.id === selected)
      : selections.length
        ? undefined
        : contexts.find(
            (context) =>
              context.kind === "personal" && context.role === "owner",
          );
    return Response.json(
      {
        contexts,
        currentContext: currentContext ?? null,
        invitations: await listAccountInvitations(database, user),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authenticationUnavailable(error);
  }
}

/** Creates an organization owned by the signed-in account, granting its creator the admin role. */
export async function POST(request: Request) {
  try {
    await requireApiAccount(request);
    assertSameOrigin(request);
    const organization = await createOrganization(
      await reviewDatabase(),
      await managementJson(request),
      requestSessionToken(request),
    );
    return Response.json(organization, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
