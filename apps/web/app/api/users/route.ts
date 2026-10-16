import { createUser, listUsers } from "@razbor/database";

import { accountInput, userInputSchema } from "@web/lib/account-input.js";
import { authenticationConfig } from "@web/lib/auth-config.js";
import {
  AuthError,
  assertSameOrigin,
  authenticationDatabase,
  authenticationUnavailable,
  requireApiUser,
  requestSessionToken,
} from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Lists account roles and grants for administrators without returning password hashes or sessions. */
export async function GET(request: Request) {
  try {
    await requireApiUser(request, { admin: true });
    return Response.json(await listUsers(await authenticationDatabase()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return authenticationUnavailable(error);
  }
}

/** Creates a local account with an initial password; repository grants belong to account contexts. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiUser(request, { admin: true });
    const input = await accountInput(request, userInputSchema);
    if (!(await authenticationConfig()).local_enabled)
      throw new AuthError(
        403,
        "Password accounts are disabled. Users join through your identity provider.",
      );
    return Response.json(
      await createUser(
        await authenticationDatabase(),
        input,
        requestSessionToken(request),
      ),
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
