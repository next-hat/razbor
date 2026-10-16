import { finishGithubAppSetup } from "@web/lib/github-app-setup.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Consume GitHub's one-time manifest callback without exposing returned App credentials. */
export async function GET(request: Request) {
  return finishGithubAppSetup(request);
}
