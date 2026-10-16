import { getRepository, listPullRequests, listReviews } from "@razbor/database";

import { RepositoryPullRequests } from "@web/components/repository-pull-requests.js";
import { RepositoryReviews } from "@web/components/repository-reviews.js";
import { pageData } from "@web/lib/page-data.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";
import { sanitizeReviewView } from "@web/lib/request-access.js";

export const dynamic = "force-dynamic";

/**
 * Seeds repository pull requests and review history within the current repository grant.
 */
export default async function Page({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  const user = await requirePageUser({ repositoryId: id });
  const isAdmin = canManageResource(user, "repository");
  const data = await pageData(async (db) => {
    const [repository, reviews] = await Promise.all([
      getRepository(db, id, user.context.id),
      listReviews(db, id, user.repositoryIds),
    ]);
    return {
      reviewCommand: repository?.reviewCommand ?? null,
      reviews: isAdmin ? reviews : reviews.map(sanitizeReviewView),
    };
  });
  const pullRequests = await pageData(async (db) =>
    (await listPullRequests(db, [id])).map((pr) =>
      visiblePullRequest(pr, isAdmin),
    ),
  );
  return (
    <>
      <RepositoryPullRequests
        key={`pull-requests-${id}`}
        id={id}
        initialData={pullRequests}
      />
      <RepositoryReviews
        key={id}
        id={id}
        isAdmin={isAdmin}
        reviewCommand={data?.reviewCommand ?? null}
        initialData={data?.reviews}
      />
    </>
  );
}
