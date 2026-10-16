import { listRepositories, listRunners } from "@razbor/database";

import { reviewDatabase } from "@web/lib/review.js";

/**
 * Combines runner status with active repository choices and a server timestamp for the
 * management page.
 */
export async function runnerData() {
  const database = await reviewDatabase();
  const [runners, repositories] = await Promise.all([
    listRunners(database),
    listRepositories(database),
  ]);
  return {
    queue: process.env.REVIEW_QUEUE ?? "reviews",
    runners,
    repositories: repositories
      .filter((repository) => repository.status === "active")
      .map((repository) => ({
        id: repository.id,
        name: repository.metadata?.fullPath ?? repository.configKey,
      })),
    asOf: new Date().toISOString(),
  };
}
