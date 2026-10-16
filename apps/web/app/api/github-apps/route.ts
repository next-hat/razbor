import { listGithubApps } from "@razbor/database/github-apps";

import { requestContextId } from "@web/lib/auth.js";
import { requireApiUser } from "@web/lib/auth.js";
import { githubAppSetupError } from "@web/lib/github-app-setup.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** List only safe saved App metadata for the authenticated administrator's repository picker. */
export async function GET(request: Request) {
  try {
    await requireApiUser(request, { resource: "repository" });
    return Response.json(
      {
        apps: await listGithubApps(
          await reviewDatabase(),
          await requestContextId(request),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return githubAppSetupError(error);
  }
}
