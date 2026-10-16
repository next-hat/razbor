import { z } from "zod";

export const reviewMetricCountSchema = z.number().int().nonnegative().safe();

/** Cumulative usage and full comparison statistics for one execution attempt. */
export const reviewAttemptMetricsSchema = z
  .object({
    inputTokens: reviewMetricCountSchema.optional(),
    outputTokens: reviewMetricCountSchema.optional(),
    cachedInputTokens: reviewMetricCountSchema.optional(),
    addedLines: reviewMetricCountSchema.optional(),
    deletedLines: reviewMetricCountSchema.optional(),
    changedFiles: reviewMetricCountSchema.optional(),
    // False means observed tokens are a lower bound because a response omitted usage.
    tokenUsageComplete: z.boolean().optional(),
    // Set by the broker only when the runner submits its final observed snapshot.
    finalized: z.boolean().optional(),
  })
  .strict();

export type ReviewAttemptMetrics = z.infer<typeof reviewAttemptMetricsSchema>;
