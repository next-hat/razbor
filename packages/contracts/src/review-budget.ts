import { z } from "zod";

/** Explicit operator prices for one exact model, in USD per million tokens. */
export const reviewPricingSchema = z
  .object({
    model: z.string().min(1).max(256),
    inputUsdPerMillion: z.number().finite().nonnegative(),
    cachedInputUsdPerMillion: z.number().finite().nonnegative(),
    outputUsdPerMillion: z.number().finite().nonnegative(),
    cacheWriteUsdPerMillion: z.number().finite().nonnegative(),
  })
  .strict();

/** Limits apply to all model calls, including automatic context compaction. */
export const reviewBudgetSchema = z
  .object({
    maxToolCalls: z.number().int().min(1).max(100000).default(2048),
    maxTokens: z.number().int().min(1).max(100000000).default(1000000),
    maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
    maxCostUsd: z.number().finite().positive().optional(),
    pricing: reviewPricingSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.maxCostUsd === undefined || value.pricing !== undefined,
    {
      message: "A monetary budget requires explicit model pricing",
      path: ["pricing"],
    },
  );

export type ReviewBudgetOptions = z.input<typeof reviewBudgetSchema>;

export type ReviewPricing = z.infer<typeof reviewPricingSchema>;
