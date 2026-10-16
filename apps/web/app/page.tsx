import { getReviewMetrics, listPullRequests } from "@razbor/database";

import Overview from "@web/components/overview.js";
import { pageData } from "@web/lib/page-data.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";

export const dynamic = "force-dynamic";

/**
 * Loads the saved human review queue and scoped stats in parallel.
 */
export default async function Page() {
  const user = await requirePageUser();
  const isAdmin = canManageResource(user, "repository");
  const repositoryIds = user.repositoryIds;
  const [metrics, pullRequests] = await Promise.all([
    pageData((db) => getReviewMetrics(db, { repositoryIds })),
    pageData(async (db) =>
      (await listPullRequests(db, repositoryIds)).map((pr) =>
        visiblePullRequest(pr, isAdmin),
      ),
    ),
  ]);
  return (
    <Overview
      initialMetrics={metrics}
      initialPullRequests={pullRequests}
      showRunnerStatus={user.role === "super_admin"}
    />
  );
}
