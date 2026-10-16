import { changeUserPassword } from "@razbor/database";

import { accountInput, passwordChangeSchema } from "@web/lib/account-input.js";
import { authenticationConfig } from "@web/lib/auth-config.js";
import {
  AuthError,
  assertSameOrigin,
  authenticationDatabase,
  authenticationUnavailable,
  requireApiUser,
  sessionResponse,
} from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Replaces the account password, revokes previous sessions, and resumes with a fresh cookie. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request, { allowPasswordChange: true });
    if (
      user.authenticationMethod === "oidc" ||
      !(await authenticationConfig()).local_enabled
    )
      throw new AuthError(
        403,
        "Manage your password with your identity provider.",
      );
    const input = await accountInput(request, passwordChangeSchema);
    const session = await changeUserPassword(
      await authenticationDatabase(),
      user.id,
      input.currentPassword,
      input.newPassword,
    );
    return sessionResponse(request, session);
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
