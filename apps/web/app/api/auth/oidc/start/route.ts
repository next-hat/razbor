import { authenticationUnavailable } from "@web/lib/auth.js";
import { startOidcLogin } from "@web/lib/oidc.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Starts the configured identity-provider sign-in without accepting local credentials. */
export async function GET(request: Request) {
  try {
    return await startOidcLogin(request);
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
