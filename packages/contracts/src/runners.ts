import { z } from "zod";

import { publicIdSchema } from "@contracts/src/ids.js";

export const runnerStateSchema = z.enum(["enabled", "draining", "revoked"]);

export const runnerSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    capacity: z.number().int().min(1).max(32),
    runtimeReady: z.boolean(),
    protocolVersion: z.literal(1),
    runtimeVersion: z.string().min(1).max(64).default("0.1.0"),
    timeoutMs: z.number().int().min(1000).max(3600000),
    fallbackModel: z.boolean(),
  })
  .strict();

export type RunnerSession = z.infer<typeof runnerSessionSchema>;

export const runnerCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) =>
        [...value].every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      ),
    repositoryIds: z.array(publicIdSchema("repository")).max(1000),
    allRepositories: z.boolean().default(false),
  })
  .strict();

export const runnerUpdateSchema = runnerCreateSchema
  .partial()
  .extend({
    allRepositories: z.boolean().optional(),
    state: runnerStateSchema.optional(),
  })
  .strict();

export type RunnerView = {
  id: string;
  name: string;
  state: z.infer<typeof runnerStateSchema>;
  status:
    | "pending"
    | "offline"
    | "online"
    | "busy"
    | "unhealthy"
    | "incompatible"
    | "revoked"
    | "draining";
  repositoryIds: string[];
  allRepositories: boolean;
  activeReviews: number;
  capacity: number;
  runtimeVersion?: string;
  lastSeenAt?: string;
  enrolledAt?: string;
  createdAt: string;
  updatedAt: string;
};

export const runnerModelPolicySchema = z
  .object({
    supports_tools: z.boolean(),
    reasoning_effort: z.enum(["low", "medium", "high"]),
    max_requests: z.number().int().min(1).max(512),
    max_retries: z.number().int().min(0).max(10),
    max_request_bytes: z.number().int().min(1024).max(10000000),
    max_response_bytes: z.number().int().min(1024).max(10000000),
    max_output_tokens: z.number().int().min(1).max(32768),
    timeout_ms: z.number().int().min(100).max(3600000),
  })
  .strict();

export type RunnerModelPolicy = z.infer<typeof runnerModelPolicySchema>;
