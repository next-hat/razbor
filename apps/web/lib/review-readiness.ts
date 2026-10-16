import { getReview, hasEligibleRunner, type Database } from "@razbor/database";

/**
 * Loads a review and annotates queued work with runner availability; returns null when
 * the review does not exist.
 */
export async function reviewWithReadiness(database: Database, id: string) {
  const review = await getReview(database, id);
  if (!review) return null;
  return {
    ...review,
    ...(review.status === "queued"
      ? { waitingForRunner: !(await hasEligibleRunner(database, id)) }
      : {}),
  };
}
