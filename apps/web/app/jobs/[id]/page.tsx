import { notFound } from "next/navigation.js";

import { getReview, publicationView } from "@razbor/database";
import { publicIdSchema } from "@razbor/contracts";

import ReviewDetail from "@web/components/review-detail.js";
import { pageData } from "@web/lib/page-data.js";
import { reviewWithReadiness } from "@web/lib/review-readiness.js";
import {
  canAccessRepository,
  canManageResource,
  requirePageUser,
} from "@web/lib/auth.js";
import { reviewDatabase } from "@web/lib/review.js";
import { sanitizeReviewView } from "@web/lib/request-access.js";

export const dynamic = "force-dynamic";

/**
 * Loads review and publication details for server rendering, returning a not-found page
 * for invalid or absent review IDs.
 */
export default async function Page({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  if (!publicIdSchema("review").safeParse(id).success) notFound();
  const user = await requirePageUser();
  const identity = await getReview(await reviewDatabase(), id);
  if (
    !identity ||
    !identity.repositoryId ||
    !canAccessRepository(user, identity.repositoryId)
  )
    notFound();
  const isAdmin = canManageResource(user, "repository");
  const initialData = await pageData(async (db) => {
    const review = await reviewWithReadiness(db, id);
    return review
      ? {
          ...(isAdmin ? review : sanitizeReviewView(review)),
          interaction: await publicationView(db, id),
        }
      : null;
  });
  if (initialData === null) notFound();
  return (
    <ReviewDetail
      key={id}
      id={id}
      initialData={initialData}
      isAdmin={isAdmin}
    />
  );
}
