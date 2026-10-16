import { githubAppRepositories } from "@razbor/database/github-apps";

import { requestContextId } from "@web/lib/auth.js";
import { requireApiUser } from "@web/lib/auth.js";
import { githubAppSetupError } from "@web/lib/github-app-setup.js";
import { reviewDatabase } from "@web/lib/review.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Discover repositories through the saved App's authenticated installations, never callback-supplied grants. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiUser(request, { resource: "repository" });
    return Response.json(
      await githubAppRepositories(
        await reviewDatabase(),
        (await params).id,
        await requestContextId(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return githubAppSetupError(error);
  }
}
