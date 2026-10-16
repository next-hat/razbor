import { z } from "zod";

const findingEvaluationSchema = z.enum([
  "confirmed",
  "potential_false_positive",
]);

const findingIndexKeySchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((key) => Number.isSafeInteger(Number(key)), "Invalid finding index");

export const reviewEvaluationSchema = z
  .object({
    included: z.boolean(),
    findings: z.record(findingIndexKeySchema, findingEvaluationSchema),
  })
  .strict();

export const reviewEvaluationUpdateSchema = z.union([
  z.object({ included: z.boolean() }).strict(),
  z
    .object({
      findingIndex: z.number().int().nonnegative().safe(),
      verdict: findingEvaluationSchema.nullable(),
    })
    .strict(),
]);

export type FindingEvaluation = z.infer<typeof findingEvaluationSchema>;

export type ReviewEvaluation = z.infer<typeof reviewEvaluationSchema>;

export type ReviewEvaluationUpdate = z.infer<
  typeof reviewEvaluationUpdateSchema
>;
