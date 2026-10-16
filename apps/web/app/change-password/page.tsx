import { redirect } from "next/navigation.js";

import { ChangePasswordForm } from "@web/components/change-password-form.js";
import { currentUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Allows signed-in accounts to replace their password, including initial credentials. */
export default async function Page() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.authenticationMethod === "oidc") redirect("/");
  return (
    <ChangePasswordForm
      username={user.username ?? user.displayName}
      required={user.mustChangePassword}
    />
  );
}
