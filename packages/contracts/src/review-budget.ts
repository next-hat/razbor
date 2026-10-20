import { z } from "zod";

/** Explicit operator prices for one provider/model pair, in USD per million tokens. */
export const reviewPricingSchema = z
  .object({
    // Legacy prices without a provider refer to the original OpenAI provider.
    provider: z.enum(["openai", "anthropic"]).default("openai"),
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
    pricing: z
      .union([
        reviewPricingSchema,
        z.array(reviewPricingSchema).min(1).max(128),
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const entries = Array.isArray(value.pricing)
      ? value.pricing
      : value.pricing
        ? [value.pricing]
        : [];
    const identities = new Set<string>();
    for (const entry of entries) {
      const identity = JSON.stringify([entry.provider, entry.model]);
      if (identities.has(identity))
        context.addIssue({
          code: "custom",
          message: "Duplicate model pricing",
          path: ["pricing"],
        });
      identities.add(identity);
    }
  })
  .refine(
    (value) => value.maxCostUsd === undefined || value.pricing !== undefined,
    {
      message: "A monetary budget requires explicit model pricing",
      path: ["pricing"],
    },
  );

export type ReviewBudgetOptions = z.input<typeof reviewBudgetSchema>;

export type ReviewPricing = z.infer<typeof reviewPricingSchema>;
