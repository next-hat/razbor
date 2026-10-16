import { authenticateUser } from "@razbor/database";

import { accountInput, credentialsSchema } from "@web/lib/account-input.js";
import { authenticationConfig } from "@web/lib/auth-config.js";
import {
  AuthError,
  assertSameOrigin,
  authenticationDatabase,
  authenticationUnavailable,
  sessionResponse,
} from "@web/lib/auth.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

const loginAttempts = new Map<string, { count: number; until: number }>();

let windowStart = 0;

let globalAttempts = 0;

/** Bounds password verification work per username and server process without storing credentials. */
function reserveLogin(username: string) {
  const now = Date.now();
  if (now - windowStart >= 60000) {
    windowStart = now;
    globalAttempts = 0;
    for (const [name, attempts] of loginAttempts)
      if (attempts.until <= now) loginAttempts.delete(name);
  }
  const key = username.toLowerCase();
  const attempts = loginAttempts.get(key);
  if (
    globalAttempts >= 60 ||
    (attempts && attempts.until > now && attempts.count >= 8)
  )
    throw new AuthError(
      429,
      "Too many sign-in attempts. Try again in a minute.",
    );
  globalAttempts++;
  loginAttempts.set(key, {
    count: attempts && attempts.until > now ? attempts.count + 1 : 1,
    until: attempts && attempts.until > now ? attempts.until : now + 60000,
  });
}

/** Authenticates an administrator-created account and issues a private session cookie. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!(await authenticationConfig()).local_enabled)
      throw new AuthError(
        403,
        "Password sign-in is disabled. Use your identity provider.",
      );
    const input = await accountInput(request, credentialsSchema);
    reserveLogin(input.username);
    const session = await authenticateUser(
      await authenticationDatabase(),
      input.username,
      input.password,
    );
    if (!session) throw new AuthError(401, "Invalid username or password.");
    return sessionResponse(request, session);
  } catch (error) {
    return authenticationUnavailable(error);
  }
}
