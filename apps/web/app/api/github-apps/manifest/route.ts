import { startGithubAppSetup } from "@web/lib/github-app-setup.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Begin administrator-owned GitHub App creation with a session-bound manifest. */
export async function POST(request: Request) {
  return startGithubAppSetup(request);
}
