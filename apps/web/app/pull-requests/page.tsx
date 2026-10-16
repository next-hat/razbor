import { listPullRequests } from "@razbor/database";

import PullRequestsPage from "@web/components/pull-requests-page.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { pageData } from "@web/lib/page-data.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";

export const dynamic = "force-dynamic";

/** Loads saved PRs using server-resolved repository grants and a validated state filter. */
export default async function Page({
  searchParams,
}: Readonly<{ searchParams: Promise<{ state?: string }> }>) {
  const user = await requirePageUser();
  const isAdmin = canManageResource(user, "repository");
  const state = (await searchParams).state;
  const initialData = await pageData(async (db) =>
    (await listPullRequests(db, user.repositoryIds)).map((pr) =>
      visiblePullRequest(pr, isAdmin),
    ),
  );
  return (
    <PullRequestsPage
      initialData={initialData}
      state={state === "closed" || state === "all" ? state : "open"}
    />
  );
}
