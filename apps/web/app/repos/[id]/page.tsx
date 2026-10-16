import { getReviewMetrics, listPullRequests } from "@razbor/database";

import { RepositoryOverview } from "@web/components/repository-overview.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";

export const dynamic = "force-dynamic";

/** Loads repository-scoped review metrics and pull requests for its authorized overview. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const user = await requirePageUser({ repositoryId: id });
  const isAdmin = canManageResource(user, "repository");
  const [metrics, pullRequests] = await Promise.all([
    pageData((db) =>
      getReviewMetrics(db, {
        repositoryId: id,
        repositoryIds: user.repositoryIds,
      }),
    ),
    pageData(async (db) =>
      (await listPullRequests(db, [id])).map((pr) =>
        visiblePullRequest(pr, isAdmin),
      ),
    ),
  ]);
  return (
    <RepositoryOverview
      key={id}
      id={id}
      initialMetrics={metrics}
      initialPullRequests={pullRequests}
    />
  );
}
