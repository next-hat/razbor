import { notFound } from "next/navigation.js";

import { publicIdSchema } from "@razbor/contracts";
import { getPullRequest } from "@razbor/database";

import PullRequestPage from "@web/components/pull-request-detail.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { visiblePullRequest } from "@web/lib/pull-requests.js";

export const dynamic = "force-dynamic";

/** Returns only granted PR details; invalid, missing and unauthorized IDs share a not-found response. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!publicIdSchema("pullRequest").safeParse(id).success) notFound();
  const isAdmin = canManageResource(user, "repository");
  const pr = await getPullRequest(
    await reviewDatabase(),
    id,
    user.repositoryIds,
  );
  if (!pr) notFound();
  return (
    <PullRequestPage
      key={id}
      id={id}
      initialData={visiblePullRequest(pr, isAdmin)}
      isAdmin={isAdmin}
    />
  );
}
