import { redirect } from "next/navigation.js";

import { LoginForm } from "@web/components/login-form.js";
import { authenticationConfig } from "@web/lib/auth-config.js";
import { currentUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Opens sign-in only for anonymous visitors and resumes existing sessions. */
export default async function Page({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const user = await currentUser();
  if (user) redirect(user.mustChangePassword ? "/change-password" : "/");
  const settings = await authenticationConfig();
  const parameters = await searchParams;
  const identityError = parameters.error === "oidc";
  const signedOut = parameters.signed_out === "1";
  if (settings.oidc?.auto_redirect && !identityError && !signedOut)
    redirect("/api/auth/oidc/start");
  return (
    <LoginForm
      localEnabled={settings.local_enabled}
      oidcEnabled={Boolean(settings.oidc)}
      identityError={identityError}
      signedOut={signedOut}
    />
  );
}
