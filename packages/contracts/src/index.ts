import { z } from "zod";

import type { ReviewEvaluation } from "@contracts/src/evaluation.js";
import { publicIdSchema } from "@contracts/src/ids.js";
import { memoryCapabilitySchema } from "@contracts/src/memory.js";
import {
  mcpServerSnapshotSchema,
  preparedMcpServerSchema,
} from "@contracts/src/mcp.js";
import { reviewMetricCountSchema } from "@contracts/src/telemetry.js";
import { reviewBudgetSchema } from "@contracts/src/review-budget.js";
import {
  MAX_SKILL_FILE_BYTES,
  reviewGuidanceSnapshotSchema,
  skillSnapshotSchema,
  type ReviewGuidanceView,
} from "@contracts/src/skills.js";

export * from "@contracts/src/skills.js";

export * from "@contracts/src/review-budget.js";

export * from "@contracts/src/github-app.js";

export * from "@contracts/src/evaluation.js";

export * from "@contracts/src/mcp.js";

export * from "@contracts/src/indexing.js";

export {
  reviewAttemptMetricsSchema,
  reviewMetricCountSchema,
  type ReviewAttemptMetrics,
} from "@contracts/src/telemetry.js";

export {
  publicIdSchema,
  publicIdPattern,
  publicIdPrefixes,
  type ResourceKind,
} from "@contracts/src/ids.js";

export const reviewReplacementSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    code: z.string(),
  })
  .strict()
  .refine((r) => r.endLine >= r.startLine, "replacement range is reversed");

export const reviewFindingSchema = z
  .object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    path: z.string().min(1),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().min(1),
    failureScenario: z.string().min(1),
    suggestion: z.string().min(1),
    // Omitted in saved reviews; new output uses null when only advice is safe.
    replacement: reviewReplacementSchema.nullable().optional(),
  })
  .refine((f) => f.lineEnd >= f.lineStart, "finding range is reversed");

export const MAX_REVIEW_FINDINGS = 20;

export const providerReferenceSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[!-~]+$/);

export const reviewResultSchema = z.object({
  mode: z.enum(["review", "conversation"]).optional(),
  // Optional so saved reviews from before change summaries remain readable.
  prSummary: z
    .object({
      title: z.string().trim().min(1),
      description: z.string().trim().min(1),
      // Optional so existing saved PR summaries without diagrams stay valid.
      diagram: z.string().trim().min(1).nullable().optional(),
      labels: z
        .array(
          z.enum([
            "enhancement",
            "bugfix",
            "refactor",
            "tests",
            "documentation",
            "maintenance",
          ]),
        )
        .max(6)
        .refine(
          (labels) => new Set(labels).size === labels.length,
          "PR summary labels must be unique",
        ),
    })
    .strict()
    .optional(),
  summary: z.string(),
  findings: z.array(reviewFindingSchema).max(MAX_REVIEW_FINDINGS),
  findingChecks: z
    .array(
      z
        .object({
          id: providerReferenceSchema,
          status: z.enum(["resolved", "open", "uncertain"]),
          evidence: z.string().trim().min(1).max(2000),
        })
        .strict(),
    )
    .max(100)
    .optional(),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const conversationMessageSchema = z
  .object({
    id: providerReferenceSchema,
    author: z.string().max(200),
    body: z.string().max(65536),
  })
  .strict();

export const previousFindingSchema = z
  .object({
    id: providerReferenceSchema,
    reviewId: publicIdSchema("review"),
    finding: reviewFindingSchema,
    originalHead: z.string().optional(),
    threadId: providerReferenceSchema.optional(),
    discussion: z.array(conversationMessageSchema).max(100).optional(),
  })
  .strict();

export const previousFindingsSchema = z
  .array(previousFindingSchema)
  .max(100)
  .refine(
    (findings) => JSON.stringify(findings).length <= 200000,
    "Previous finding context is too large",
  );

export type PreviousFinding = z.infer<typeof previousFindingSchema>;

export const reviewConversationSchema = z
  .object({
    reviewId: publicIdSchema("review"),
    originalBase: z.string(),
    originalHead: z.string(),
    originalReview: reviewResultSchema,
    title: z.string().max(65536),
    target: z
      .object({
        commentId: providerReferenceSchema,
        threadId: providerReferenceSchema.optional(),
        reviewId: providerReferenceSchema,
        path: z.string().min(1),
        lineStart: z.number().int().positive().safe(),
        lineEnd: z.number().int().positive().safe(),
      })
      .strict()
      .refine(
        (t) => t.lineEnd >= t.lineStart,
        "conversation range is reversed",
      ),
    history: z.array(conversationMessageSchema).max(100),
    reply: conversationMessageSchema,
  })
  .strict()
  .refine(
    (c) => JSON.stringify(c).length <= 200000,
    "Conversation context is too large",
  );

export type ReviewConversation = z.infer<typeof reviewConversationSchema>;

/**
 * Reject results that violate conversation mode or fail to assess each prior
 * finding exactly once; resolved findings must not remain actionable.
 */
export function validateFindingChecks(
  result: ReviewResult,
  previous: PreviousFinding[] = [],
  conversational = false,
) {
  if (conversational) {
    if (
      result.mode !== "conversation" ||
      !result.summary.trim() ||
      result.findings.length ||
      result.findingChecks !== undefined
    )
      throw new Error("Invalid conversational response");
    return;
  }
  if (result.mode === "conversation")
    throw new Error("Unexpected conversational response");
  const expected = new Set(previous.map((f) => f.id));
  const checked = new Set<string>();
  for (const check of result.findingChecks ?? []) {
    if (!expected.has(check.id) || checked.has(check.id))
      throw new Error("Invalid previous finding assessment");
    const old = previous.find((p) => p.id === check.id)!;
    if (
      check.status === "resolved" &&
      result.findings.some(
        (f) =>
          f.path === old.finding.path &&
          (f.title === old.finding.title || f.body === old.finding.body),
      )
    )
      throw new Error("Resolved finding is still reported as actionable");
    checked.add(check.id);
  }
  if (checked.size !== expected.size)
    throw new Error("Missing previous finding assessments");
}

export const commitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full commit ID");

// Reporting labels never select a checkout; execution remains pinned to commit IDs.
export const reviewBranchSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (branch) =>
      [...branch].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    "Branch labels cannot contain control characters",
  );

export const reviewRequestSchema = z
  .object({
    repositoryId: publicIdSchema("repository"),
    baseSha: commitSchema,
    headSha: commitSchema,
    headBranch: reviewBranchSchema.optional(),
    baseBranch: reviewBranchSchema.optional(),
  })
  .strict();

export const queueJobSchema = reviewRequestSchema
  .omit({ headBranch: true, baseBranch: true })
  .extend({
    version: z.literal(1),
    reviewId: publicIdSchema("review"),
    submittedAt: z.string().datetime(),
    previousFindings: previousFindingsSchema.optional(),
    conversation: reviewConversationSchema.optional(),
    guidance: reviewGuidanceSnapshotSchema.optional(),
    mcpServers: z.array(mcpServerSnapshotSchema).max(16).optional(),
  })
  .strict();

export type QueueJob = z.infer<typeof queueJobSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

export const reviewMaxTurnsSchema = z
  .number()
  .int()
  .min(1)
  .max(512)
  .default(512);

export const reviewProgressSchema = z.object({
  time: z.string().datetime(),
  level: z.enum(["info", "warn", "error"]),
  source: z.enum(["app", "runner", "agent"]).optional(),
  stage: z.enum(["prepare", "agent", "model", "tool", "result", "cleanup"]),
  message: z.string().min(1).max(1000),
  detail: z.boolean().optional(),
  tool: z
    .object({
      id: z.number().int().positive().safe(),
      name: z.string().min(1).max(200),
      summary: z.string().max(600).optional(),
      status: z.enum(["running", "completed", "failed"]),
      durationMs: z.number().int().nonnegative().safe().optional(),
      exitCode: z.number().int().nullable().optional(),
      timedOut: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    })
    .optional(),
  model: z.string().min(1).max(200).optional(),
  turn: z.number().int().min(0).max(512).optional(),
  maxTurns: reviewMaxTurnsSchema.removeDefault().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  inputTokens: reviewMetricCountSchema.optional(),
  cachedInputTokens: reviewMetricCountSchema.optional(),
  uncachedInputTokens: reviewMetricCountSchema.optional(),
  cacheWriteTokens: reviewMetricCountSchema.optional(),
  modelTurns: reviewMetricCountSchema.optional(),
  budgetTokens: reviewMetricCountSchema.optional(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
  costEstimateComplete: z.boolean().optional(),
  outputTokens: reviewMetricCountSchema.optional(),
  addedLines: reviewMetricCountSchema.optional(),
  deletedLines: reviewMetricCountSchema.optional(),
  changedFiles: reviewMetricCountSchema.optional(),
  tokenUsageComplete: z.boolean().optional(),
});

export type ReviewProgress = z.infer<typeof reviewProgressSchema>;

export const reviewLogSchema = reviewProgressSchema.extend({
  attemptId: publicIdSchema("attempt"),
});

export type ReviewLog = z.infer<typeof reviewLogSchema>;

export const modelProviderSchema = z.enum(["openai", "anthropic"]);

export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export type ReviewAgentSnapshot = {
  id: string;
  // Snapshots saved before provider selection use OpenAI Responses.
  provider?: ModelProvider;
  endpoint: string;
  model: string;
  // Older snapshots retain the runner policy rather than inventing past settings.
  reasoningEffort?: ReasoningEffort;
  updatedAt: string;
};

export type ReviewJobView = {
  id: string;
  repositoryId: string;
  status: JobStatus;
  baseSha?: string;
  headSha?: string;
  changeTitle?: string;
  evaluation?: ReviewEvaluation;
  waitingForRunner?: boolean;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  agent?: ReviewAgentSnapshot;
  guidance?: ReviewGuidanceView;
  review?: ReviewResult;
  error?: string;
};

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const capabilityLimitsSchema = z
  .object({
    instructionBytes: z.number().int().min(256).max(200000).default(32768),
    skillBytes: z
      .number()
      .int()
      .min(256)
      .max(200000)
      .default(MAX_SKILL_FILE_BYTES),
    skillCount: z.number().int().min(1).max(200).default(100),
    // Reserve space for JSON escaping and metadata around a full 128 KiB skill.
    toolOutputBytes: z.number().int().min(1024).max(524288).default(524288),
  })
  .strict();

export const codebaseMemorySchema = z
  .object({
    endpoint: z.string().url(),
    tokenEnv: z.literal("RAZBOR_MCP_TOKEN").default("RAZBOR_MCP_TOKEN"),
    project: publicIdSchema("workspace"),
    indexHeadSha: commitSchema,
    indexBranch: z.string().min(1),
    startupMs: z.number().int().min(100).max(60000).default(15000),
    queryMs: z.number().int().min(100).max(60000).default(15000),
  })
  .strict();

export const preparedCapabilitiesSchema = z
  .object({
    instructions: z
      .array(
        z
          .object({
            path: z.string().startsWith("/"),
            provenance: z.string().max(1100),
            scope: z
              .string()
              .max(1000)
              .refine(
                (value) =>
                  value === "" ||
                  (!value.startsWith("/") &&
                    !/[\\\\:]/.test(value) &&
                    [...value].every(
                      (character) =>
                        character.charCodeAt(0) >= 32 &&
                        character.charCodeAt(0) !== 127,
                    ) &&
                    value
                      .split("/")
                      .every((part) => part && part !== "." && part !== "..")),
                "Instruction scopes must be safe repository-relative paths.",
              )
              .optional(),
          })
          .strict(),
      )
      .max(102)
      .default([]),
    skills: z.array(z.string().startsWith("/")).max(18).default([]),
    includedSkills: z
      .array(
        skillSnapshotSchema
          .pick({ id: true, name: true, version: true })
          .extend({ path: z.string().startsWith("/") }),
      )
      .max(100)
      .optional(),
    codebaseMemory: codebaseMemorySchema.optional(),
    mcpServers: z.array(preparedMcpServerSchema).max(16).optional(),
    memory: memoryCapabilitySchema.optional(),
    limits: capabilityLimitsSchema.prefault({}),
  })
  .strict();

export type PreparedCapabilities = z.infer<typeof preparedCapabilitiesSchema>;

export const agentJobSchema = z.object({
  version: z.literal(1),
  reviewId: publicIdSchema("review"),
  repository: z.string().startsWith("/"),
  base: commitSchema,
  head: commitSchema,
  baseline: commitSchema.optional(),
  initialDiffMaxBytes: z.number().int().min(0).max(1000000).default(4096),
  supportsTools: z.boolean().default(true),
  maxTurns: reviewMaxTurnsSchema,
  reviewBudget: reviewBudgetSchema.optional(),
  compactionThresholdTokens: z
    .number()
    .int()
    .min(1024)
    .max(1000000)
    .default(80000),
  capabilities: preparedCapabilitiesSchema.optional(),
  previousFindings: previousFindingsSchema.optional(),
  conversation: reviewConversationSchema.optional(),
});

export type AgentJob = z.infer<typeof agentJobSchema>;

export * from "@contracts/src/runners.js";

export * from "@contracts/src/metrics.js";

export * from "@contracts/src/memory.js";
