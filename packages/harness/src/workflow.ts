import { noopLogger } from "@mastra/core/logger";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { reviewResultSchema, type ReviewResult } from "@razbor/contracts";

import {
  checkpointSchema,
  type ReviewCheckpoint,
  type ReviewStage,
} from "@harness/src/evidence.js";

export class IncompleteReviewError extends Error {
  /** Keeps a failed checkpoint distinct from a completed review with zero findings. */
  constructor(readonly gaps: string[]) {
    super(`Review incomplete: ${gaps.join(" ")}`);
  }
}

/**
 * Runs explicit investigation, verification, challenge and final checkpoints in a
 * transient Mastra workflow. One evidence revisit is shared across all stages;
 * the caller owns the single model-turn budget and never persists workflow state.
 */
export async function runReviewWorkflow<Result = ReviewResult>(options: {
  signal?: AbortSignal;
  outputSchema?: z.ZodType<Result>;
  checkpoint(
    stage: ReviewStage,
    previous?: ReviewCheckpoint,
    gaps?: string[],
  ): Promise<string>;
  gaps(
    checkpoint: ReviewCheckpoint,
    stage: ReviewStage,
    previous?: ReviewCheckpoint,
  ): string[];
  finalize(challenge: ReviewCheckpoint): Promise<Result>;
  progress(
    stage: ReviewStage | "final",
    state: "started" | "passed" | "revisit",
    gaps?: string[],
  ): void;
}): Promise<Result> {
  let revisits = 0;
  let failure: unknown;
  const outputSchema =
    options.outputSchema ??
    (reviewResultSchema as unknown as z.ZodType<Result>);
  const startSchema = z.object({});
  /** Runs and validates one checkpoint, preserving one bounded opportunity to gather missing evidence. */
  const checkpoint = async (
    stage: ReviewStage,
    previous?: ReviewCheckpoint,
  ) => {
    options.signal?.throwIfAborted();
    options.progress(stage, "started");
    let gaps: string[] | undefined;
    while (true) {
      const text = await options.checkpoint(stage, previous, gaps);
      let result: ReviewCheckpoint | undefined;
      try {
        result = checkpointSchema.parse(JSON.parse(text));
      } catch {
        gaps = [
          "Return the complete checkpoint JSON schema with real evidence IDs.",
        ];
      }
      if (result) gaps = options.gaps(result, stage, previous);
      if (result && !gaps?.length) {
        options.progress(stage, "passed");
        return result;
      }
      if (revisits++)
        throw new IncompleteReviewError(gaps ?? ["Invalid checkpoint"]);
      options.progress(stage, "revisit", gaps);
    }
  };
  /** Captures the original safe harness failure before Mastra serializes step errors. */
  const guarded = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  const workflow = createWorkflow({
    id: "razbor-review",
    inputSchema: startSchema,
    outputSchema,
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(
      createStep({
        id: "investigate",
        inputSchema: startSchema,
        outputSchema: checkpointSchema,
        retries: 0,
        execute: () => guarded(() => checkpoint("investigate")),
      }),
    )
    .then(
      createStep({
        id: "verify",
        inputSchema: checkpointSchema,
        outputSchema: checkpointSchema,
        retries: 0,
        execute: ({ inputData }) =>
          guarded(() => checkpoint("verify", inputData)),
      }),
    )
    .then(
      createStep({
        id: "challenge",
        inputSchema: checkpointSchema,
        outputSchema: checkpointSchema,
        retries: 0,
        execute: ({ inputData }) =>
          guarded(() => checkpoint("challenge", inputData)),
      }),
    )
    .then(
      createStep({
        id: "final",
        inputSchema: checkpointSchema,
        outputSchema,
        retries: 0,
        execute: ({ inputData }) =>
          guarded(async () => {
            options.signal?.throwIfAborted();
            options.progress("final", "started");
            const result = await options.finalize(inputData);
            options.signal?.throwIfAborted();
            options.progress("final", "passed");
            return result;
          }),
      }),
    )
    .commit();
  workflow.__setLogger(noopLogger);
  const run = await workflow.createRun();
  // The model and every tool share the external signal. Check it at every step;
  // no independent workflow retry or detached execution can outlive the attempt.
  const result = await run.start({ inputData: {} });
  options.signal?.throwIfAborted();
  if (result.status !== "success")
    throw (
      failure ?? new IncompleteReviewError(["Review workflow did not complete"])
    );
  return result.result;
}
