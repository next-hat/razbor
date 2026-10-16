import { sql } from "drizzle-orm";

import {
  reviewResultSchema,
  reviewEvaluationSchema,
  type ReviewJobView,
  type ReviewGuidanceSnapshot,
  type ReviewEvaluation,
} from "@razbor/contracts";

import { reviews, reviewTriggers, repositories } from "@database/src/schema.js";

export const reviewViewSelection = {
  publicId: reviews.publicId,
  repositoryPublicId: repositories.publicId,
  status: reviews.status,
  baseSha: reviews.baseSha,
  headSha: reviews.headSha,
  changeTitle: sql<
    string | null
  >`coalesce(${reviewTriggers.change}->>'title', ${reviews.source}->'pullRequest'->>'title')`,
  evaluation: reviews.evaluation,
  createdAt: reviews.createdAt,
  startedAt: reviews.startedAt,
  finishedAt: reviews.finishedAt,
  result: reviews.result,
  agent: sql<ReviewJobView["agent"] | null>`${reviews.source}->'agent'`,
  guidance: sql<ReviewGuidanceSnapshot | null>`${reviews.source}->'guidance'`,
};

/**
 * Build a public review response with the captured PR title when available,
 * validated results, UTC timestamps and a generic failure message.
 */
export function reviewView(row: {
  publicId: string;
  repositoryPublicId: string;
  status: ReviewJobView["status"];
  baseSha: string;
  headSha: string;
  changeTitle: string | null;
  evaluation: ReviewEvaluation;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: typeof reviews.$inferSelect.result;
  agent: ReviewJobView["agent"] | null;
  guidance: ReviewGuidanceSnapshot | null;
}): ReviewJobView {
  return {
    id: row.publicId,
    repositoryId: row.repositoryPublicId,
    status: row.status,
    baseSha: row.baseSha,
    headSha: row.headSha,
    ...(row.changeTitle?.trim() ? { changeTitle: row.changeTitle } : {}),
    evaluation: reviewEvaluationSchema.parse(row.evaluation),
    submittedAt: row.createdAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(row.result ? { review: reviewResultSchema.parse(row.result) } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.guidance
      ? {
          guidance: {
            repositoryInstructions: row.guidance.repositoryInstructions,
            repositorySkills: row.guidance.repositorySkills,
            alwaysIncludeSkillIds: row.guidance.alwaysIncludeSkillIds,
            skills: row.guidance.skills.map(
              ({ id, name, description, version }) => ({
                id,
                name,
                description,
                version,
              }),
            ),
          },
        }
      : {}),
    ...(row.status === "failed"
      ? {
          error:
            "Review failed. Check the trusted runner logs with this review ID.",
        }
      : {}),
  };
}
