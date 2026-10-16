import { updateUser } from "@razbor/database";

import { accountInput, userUpdateSchema } from "@web/lib/account-input.js";
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

/** Updates account access or resets its password, with immediate session revocation. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiUser(request, { admin: true });
    const { id } = await params;
    if (!/^usr_[A-Za-z0-9]{16}$/.test(id))
      throw new AuthError(404, "Account not found.");
    const input = await accountInput(request, userUpdateSchema);
    return Response.json(
      await updateUser(
        await authenticationDatabase(),
        id,
        input,
        requestSessionToken(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
