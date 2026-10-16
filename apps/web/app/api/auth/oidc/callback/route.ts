import { authenticationUnavailable } from "@web/lib/auth.js";
import { finishOidcLogin } from "@web/lib/oidc.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Consumes one code-flow response and redirects to the console or a safe sign-in error. */
export async function GET(request: Request) {
  try {
    return await finishOidcLogin(request);
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
