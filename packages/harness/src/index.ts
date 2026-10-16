import type { ModelMessage } from "ai";
import type OpenAI from "openai";

import {
  reviewResultSchema,
  reviewMaxTurnsSchema,
  MAX_REVIEW_FINDINGS,
  validateFindingChecks,
  type ModelProvider,
  type ReasoningEffort,
  type PreviousFinding,
  type ReviewConversation,
  type ReviewResult,
  type PreparedCapabilities,
  type ReviewProgress,
  type ReviewAttemptMetrics,
} from "@razbor/contracts";

import { renderPrompt } from "@harness/src/prompts.js";
import {
  createReviewModel,
  ModelRequestError,
  type ModelToolCall,
  type ModelTurn,
} from "@harness/src/model.js";
import {
  checkpointSchema,
  ReviewEvidenceLedger,
  selectReviewFocus,
  type ReviewCheckpoint,
  type ReviewStage,
} from "@harness/src/evidence.js";
import { compactReviewContext } from "@harness/src/context.js";
import {
  IncompleteReviewError,
  runReviewWorkflow,
} from "@harness/src/workflow.js";
import { inspectReviewEnvironment } from "@harness/src/environment.js";
import { logger } from "@harness/src/logger.js";
import { RepositoryTools, toolError } from "@harness/src/tools/repository.js";
import { ReviewCapabilities } from "@harness/src/capabilities/index.js";
import { git, GitOutputLimitError } from "@harness/src/git.js";
import { toolProgressSummary } from "@harness/src/tools/progress.js";
import {
  VerificationTools,
  type VerificationOptions,
} from "@harness/src/tools/verification.js";

export type {
  VerificationOptions,
  WebSearchProvider,
  WebSearchResult,
} from "@harness/src/tools/verification.js";

// Bound simultaneous subprocess reads and remote queries within one model turn.
const MAX_PARALLEL_TOOL_CALLS = 4;

// Commands and skill loading can change shared state. The indexer queues CBM
// calls per workspace, so submitting them concurrently would spend their query
// deadlines waiting. New tool names also default to ordered execution.
const parallelToolNames = new Set<string>([
  "read_file",
  "read_diff",
  "find_skill",
  "web_search",
  "fetch_url",
]);

export type ReviewConfig = {
  baseUrl: string;
  model: string;
  provider?: ModelProvider;
  apiKey: string;
  initialDiffMaxBytes?: number;
  supportsTools?: boolean;
  maxTurns?: number;
  baselineSha?: string;
  reasoningEffort: ReasoningEffort;
  signal?: AbortSignal;
  reviewId: string;
  capabilities?: PreparedCapabilities;
  verification?: VerificationOptions;
  previousFindings?: PreviousFinding[];
  conversation?: ReviewConversation;
  onProgress?: (event: ReviewProgress) => void;
};

/**
 * Combines verification tools with schemas and prompt descriptions for reading pinned
 * source and diff pages.
 */
async function repositoryToolDefinitions(
  verification: VerificationTools,
): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
  return [
    ...(await verification.definitions()),
    {
      type: "function",
      function: {
        name: "read_file",
        description: await renderPrompt("tools/read-file"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            revision: {
              type: ["string", "null"],
              enum: ["head", "baseline", null],
            },
            startLine: { type: ["integer", "null"], minimum: 1 },
            endLine: { type: ["integer", "null"], minimum: 1 },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_diff",
        description: await renderPrompt("tools/read-diff"),
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 8,
            },
            cursor: { type: ["string", "null"] },
          },
          required: ["paths"],
          additionalProperties: false,
        },
      },
    },
  ];
}

/**
 * Requires a clean checkout at the recorded head when Codebase Memory is enabled, so
 * navigation evidence matches the review.
 */
async function validateCheckout(
  repository: string,
  head: string,
  config: ReviewConfig,
) {
  if (config.capabilities?.codebaseMemory) {
    if (
      (await git(repository, ["rev-parse", "HEAD"], config.signal)) !== head ||
      (await git(
        repository,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        config.signal,
      ))
    )
      throw new Error(
        "agent checkout must be clean and match the recorded review head",
      );
  }
}

type Progress = (
  stage: ReviewProgress["stage"],
  message: string,
  level?: ReviewProgress["level"],
  metadata?: Pick<ReviewProgress, "detail" | "tool">,
) => void;

/**
 * Appends either prior findings or the active conversation and user reply to the model
 * input, preserving their distinct review modes.
 */
async function appendReviewHistory(
  config: ReviewConfig,
  input: ModelMessage[],
  progress: Progress,
) {
  if (!config.conversation && config.previousFindings?.length) {
    progress(
      "agent",
      `Rechecking ${config.previousFindings.length} previous findings`,
    );
    input.push({
      role: "user",
      content: await renderPrompt("previous-findings", {
        findings: config.previousFindings.map(
          ({ id, finding, originalHead, discussion }) => ({
            id,
            finding,
            originalHead,
            discussion,
          }),
        ),
      }),
    });
  }
  if (config.conversation) {
    const { reply, ...context } = config.conversation;
    input.push(
      {
        role: "user",
        content: await renderPrompt("conversation-context", { context }),
      },
      {
        role: "user",
        content: await renderPrompt("user-reply", {
          author: reply.author,
          body: reply.body,
        }),
      },
    );
  }
}

/**
 * Classifies failures for progress reporting without exposing model payloads or
 * underlying exception messages.
 */
function reviewFailure(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return "cancelled";
  if (error instanceof GitOutputLimitError)
    return `${error.code} · ${error.message}`;
  if (error instanceof ModelRequestError)
    return `model HTTP ${error.status ?? "connection failure"}`;
  if (error instanceof IncompleteReviewError) return "Review incomplete";
  return error instanceof SyntaxError
    ? "invalid JSON from model or tool arguments"
    : "execution or validation error";
}

/**
 * Rejects findings outside regular recorded-head files and removes replacements that do
 * not cover the entire finding range within a localized source range, retaining prose advice.
 */
async function validateFindingLocations(
  review: ReviewResult,
  rtools: RepositoryTools,
  repository: string,
  head: string,
  config: ReviewConfig,
  progress: Progress,
) {
  for (const f of review.findings) {
    const entry = await rtools.sourceEntry(f.path);
    if (!entry || !["100644", "100755"].includes(entry.mode))
      throw new Error("Finding path is not a regular recorded-head file");
    if (f.replacement) {
      const source = await git(
        repository,
        ["show", `${head}:${f.path}`],
        config.signal,
        false,
      );
      const lines = source.split("\n").length - Number(source.endsWith("\n"));
      const r = f.replacement;
      if (
        r.startLine > f.lineStart ||
        r.endLine < f.lineEnd ||
        r.endLine > lines ||
        (r.startLine === 1 && r.endLine === lines)
      ) {
        f.replacement = null;
        progress(
          "result",
          "Replacement outside a localized recorded-head range; keeping prose advice",
          "warn",
        );
      }
    }
  }
}

/**
 * Disables tools during JSON correction and omits tool selection entirely for models
 * configured without tool support.
 */
function reviewToolChoice(
  outputRetries: number,
  supportsTools: boolean | undefined,
) {
  if (outputRetries) return "none";
  return supportsTools === false ? undefined : "auto";
}

/**
 * Recognize usable provider token measurements without treating malformed or
 * absent compatible-provider usage as a measured zero.
 */
function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Formats reported token counts for progress messages, distinguishing unavailable usage
 * from zero usage.
 */
function tokenUsage(response: ModelTurn) {
  const usage = response.usage;
  const cached = usage.cachedInputTokens;
  return ` · ${validTokenCount(usage.inputTokens) ? usage.inputTokens : "unknown"} input / ${validTokenCount(cached) && validTokenCount(usage.inputTokens) && cached <= usage.inputTokens ? cached : "unknown"} cached-input / ${validTokenCount(usage.outputTokens) ? usage.outputTokens : "unknown"} output tokens`;
}

/**
 * Parses a complete model response and validates both its review schema and its
 * previous-finding or conversation obligations.
 */
function parseReview(
  text: string,
  tokenLimitReached: boolean,
  config: ReviewConfig,
) {
  if (tokenLimitReached) throw new Error("Incomplete review output");
  const review = reviewResultSchema.parse(JSON.parse(text));
  validateFindingChecks(review, config.previousFindings, !!config.conversation);
  return review;
}

/**
 * Reviews a pinned Git comparison through bounded model turns and approved tools.
 * Validates findings, reports safe progress, and closes capabilities on success or
 * failure.
 */
export async function reviewRepository(
  repository: string,
  base: string,
  head: string,
  config: ReviewConfig,
): Promise<ReviewResult> {
  let maxTurns = reviewMaxTurnsSchema.parse(config.maxTurns);
  const verification = new VerificationTools(
    repository,
    {
      ...config.verification,
      exec: {
        maxOutputBytes: config.capabilities?.limits.toolOutputBytes,
        ...config.verification?.exec,
      },
    },
    config.signal,
  );
  const tools = await repositoryToolDefinitions(verification);

  const threshold = config.initialDiffMaxBytes ?? 4096;
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 0 ||
    threshold > 1_000_000
  )
    throw new Error("Invalid initialDiffMaxBytes (0..1000000)");
  const id = config.reviewId,
    started = performance.now(),
    rtools = new RepositoryTools(repository, config.signal),
    input: ModelMessage[] = [
      {
        role: "system",
        content: await renderPrompt(
          config.conversation ? "conversation" : "review",
          {
            base,
            head,
            maxFindings: MAX_REVIEW_FINDINGS,
            maxTurns,
            hasPreviousFindings: !!config.previousFindings?.length,
          },
        ),
      },
    ];
  let calls = 0,
    toolCalls = 0;
  let inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0;
  let usageReported = false;
  let tokenUsageComplete = true;
  let cachedUsageComplete = true;
  let diffMetrics:
    | Pick<ReviewAttemptMetrics, "addedLines" | "deletedLines" | "changedFiles">
    | undefined;
  let outputRetries = 0;
  /**
   * Emits a timestamped progress event with current turn, tool, and available
   * cumulative token counts.
   */
  const progress = (
    stage: ReviewProgress["stage"],
    message: string,
    level: ReviewProgress["level"] = "info",
    metadata: Pick<ReviewProgress, "detail" | "tool"> = {},
  ) =>
    config.onProgress?.({
      time: new Date().toISOString(),
      level,
      source: "agent",
      stage,
      message: message.slice(0, 1000),
      ...metadata,
      turn: calls,
      maxTurns,
      toolCalls,
      ...diffMetrics,
      ...(usageReported || !tokenUsageComplete ? { tokenUsageComplete } : {}),
      ...(usageReported
        ? {
            inputTokens,
            cachedInputTokens: cachedUsageComplete
              ? cachedInputTokens
              : undefined,
            outputTokens,
          }
        : {}),
    });
  let phase = "initializing capabilities";
  logger.info({ reviewId: id, repository, base, head }, "review started");
  const client = createReviewModel(config);
  const evidence = new ReviewEvidenceLedger();
  let reviewStage: ReviewStage | "final" = "investigate";
  const capabilities = new ReviewCapabilities(
    config.capabilities,
    logger.child({ reviewId: id }),
    config.signal ?? new AbortController().signal,
  );
  try {
    if (!config.conversation && maxTurns < 4)
      throw new IncompleteReviewError([
        "Staged reviews require at least four model turns for investigation, verification, challenge and final serialization.",
      ]);
    await validateCheckout(repository, head, config);
    progress(
      "agent",
      "Loading approved instructions, skills and code navigation tools",
    );
    await capabilities.start();
    for (const instruction of config.capabilities?.instructions ?? []) {
      // Report source metadata only; instruction contents stay out of progress logs.
      progress(
        "agent",
        `Instruction loaded · ${instruction.provenance}`.slice(0, 1000),
        "info",
        { detail: true },
      );
    }
    for (const skill of config.capabilities?.includedSkills ?? []) {
      progress(
        "agent",
        `Skill included · ${skill.name} · ${skill.id} · v${skill.version} · always include`,
        "info",
        { detail: true },
      );
    }
    progress(
      "agent",
      `Capabilities ready · ${capabilities.tools.length + tools.length} tools available`,
    );
    for (const content of capabilities.instructions)
      input.push({ role: "system", content });
    const instructions = [...input];
    phase = "reading the diff";
    const prepared = await rtools.prepareDiff(
      base,
      head,
      threshold,
      config.capabilities?.limits.toolOutputBytes ?? 32768,
      config.baselineSha,
    );
    const groups = config.conversation ? [prepared] : prepared.groups();
    maxTurns = Math.min(
      maxTurns,
      24 * (groups.length > 1 ? groups.length + 1 : 1),
    );
    let activePrepared = prepared;
    let phaseTurnLimit = maxTurns;
    // Git numstat covers the full comparison; binary files have no line counts.
    diffMetrics = {
      addedLines: prepared.files.reduce(
        (sum, file) => sum + (file.added ?? 0),
        0,
      ),
      deletedLines: prepared.files.reduce(
        (sum, file) => sum + (file.deleted ?? 0),
        0,
      ),
      changedFiles: prepared.files.length,
    };
    progress(
      "agent",
      `Diff prepared · ${diffMetrics.changedFiles} files · +${diffMetrics.addedLines} / -${diffMetrics.deletedLines} lines`,
    );
    if (config.supportsTools === false && prepared.mode === "lazy") {
      const message =
        "Model tool capability required: diff exceeds initialDiffMaxBytes; manifest-only review unavailable";
      progress("result", message, "error");
      throw new Error(message);
    }
    /**
     * Snapshots diff size and supplied-content coverage without including source or
     * patch text.
     */
    const contextMetrics = () => ({
      mode: prepared.mode,
      threshold,
      changedFiles: prepared.files.length,
      manifestBytes: Buffer.byteLength(prepared.manifest),
      initialInlinePatchBytes:
        prepared.mode === "inline" ? Buffer.byteLength(prepared.patch) : 0,
      readDiffCalls: prepared.readCalls,
      readDiffReturnedBytes: prepared.returnedBytes,
      ...prepared.coverage(),
    });
    /**
     * Logs and emits content-exposure metrics so consumers can distinguish supplied
     * context from unread changes.
     */
    const reportContext = () => {
      const metrics = contextMetrics();
      logger.info({ reviewId: id, ...metrics }, "review context exposure");
      progress(
        "agent",
        `Context exposure · ${metrics.mode} diff · ${metrics.suppliedBytes} bytes supplied · ${metrics.unreadFiles} files with unread changes · ${metrics.remainingBytes} bytes remaining`,
        "info",
        { detail: true },
      );
    };
    input.push({
      role: "user",
      content: await renderPrompt("diff", {
        conversational: !!config.conversation,
        base,
        head,
        baseline: prepared.baselineSha,
        mode: prepared.mode,
        manifest: prepared.manifest,
        diff: prepared.mode === "inline" ? prepared.patch : "",
      }),
    });
    if (groups.length === 1) prepared.markInlineSupplied();
    reportContext();
    await appendReviewHistory(config, input, progress);
    const modelTools = [...tools, ...capabilities.tools];
    const environment = await inspectReviewEnvironment(
      repository,
      head,
      config.verification?.exec?.env,
      config.signal,
    );
    input.push({
      role: "user",
      content: `Review environment facts (availability is not a passing check): ${JSON.stringify(environment)}`,
    });
    for (const limitation of environment.limitations.filter((item) =>
      item.includes("unavailable"),
    ))
      progress("agent", limitation, "warn");
    let focus = await selectReviewFocus(repository, prepared, config.signal);
    if (
      !config.conversation &&
      config.supportsTools === false &&
      focus.paths.length
    )
      throw new IncompleteReviewError([
        "Model tool capability is required to supply pinned source evidence for executable changes.",
      ]);
    if (!config.conversation) {
      input.push({
        role: "system",
        content: await renderPrompt("review-focus", {
          sections: focus.sections,
          paths: focus.paths,
        }),
      });
      progress(
        "agent",
        `Focused guide sections included · ${focus.sections.map(({ name }) => name).join(", ") || "general review"}`,
        "info",
        { detail: true },
      );
      progress(
        "agent",
        `Minimum deep inspection targets · ${focus.paths.map(({ path }) => path).join(", ") || "no executable changes"}`,
        "info",
        { detail: true },
      );
    }
    let contextBase = [...input];
    let retained = [...contextBase];
    let stageEvidenceStart = 0;
    let compactedEvidenceStart: number | undefined;
    let groupedCandidates: ReviewCheckpoint["candidates"] = [];
    let crossGroupPass = false;
    let checkpointLimitations: string[] = [];
    /**
     * Appends any context-exposure limitation to the summary and reports completion
     * metrics without logging review content.
     */
    const finishReview = (review: ReviewResult) => {
      const limitation = prepared.limitation();
      if (limitation) {
        review.summary += `\n\n${limitation}`;
        progress("result", limitation, "warn");
      }
      const limitations = [...new Set(checkpointLimitations)];
      if (limitations.length)
        review.summary += `\n\nVerification limitations: ${limitations.join(" ")}`;
      reportContext();
      logger.info(
        {
          reviewId: id,
          durationMs: Math.round(performance.now() - started),
          modelCalls: calls,
          toolCalls,
          findings: review.findings.length,
          inputTokens,
          cachedInputTokens: cachedUsageComplete
            ? cachedInputTokens
            : undefined,
          outputTokens,
          ...contextMetrics(),
        },
        "review completed",
      );
      const ready = config.conversation
        ? "Reply ready"
        : `Review ready · ${review.findings.length} findings`;
      progress(
        "result",
        `${ready} · ${calls} model turns · ${toolCalls} tool calls`,
      );
    };

    /**
     * Requests the next model turn, accumulates usage, and reports status. Rejects
     * unsuccessful responses while preserving token-limit status for output validation.
     * Transport failures leave consumed usage unknown rather than treating the
     * failed request as a measured zero-token turn.
     */
    const requestTurn = async (
      withoutTools = false,
      messages: ModelMessage[] = input,
    ) => {
      config.signal?.throwIfAborted();
      if (calls >= Math.min(maxTurns, phaseTurnLimit))
        throw new IncompleteReviewError([
          `Model-turn budget exhausted before all checkpoints passed (${calls}/${maxTurns} aggregate turns; current phase ends at ${phaseTurnLimit}).`,
        ]);
      calls++;
      phase = `waiting for model turn ${calls}`;
      progress(
        "model",
        `Turn ${calls}/${maxTurns} · waiting for model response`,
        "info",
        { detail: true },
      );
      const turnStarted = performance.now();
      const response = await client
        .generate(
          messages,
          messages === input ? modelTools : [],
          config.supportsTools === false
            ? undefined
            : withoutTools
              ? "none"
              : reviewToolChoice(outputRetries, config.supportsTools),
        )
        .catch((error) => {
          tokenUsageComplete = false;
          cachedUsageComplete = false;
          throw error;
        });
      const inputUsage = response.usage.inputTokens;
      const outputUsage = response.usage.outputTokens;
      const cachedUsage = response.usage.cachedInputTokens;
      const inputMeasured =
        validTokenCount(inputUsage) &&
        validTokenCount(inputTokens + inputUsage);
      const outputMeasured =
        validTokenCount(outputUsage) &&
        validTokenCount(outputTokens + outputUsage);
      const cachedMeasured =
        validTokenCount(cachedUsage) &&
        inputMeasured &&
        cachedUsage <= inputUsage &&
        validTokenCount(cachedInputTokens + cachedUsage);
      if (inputMeasured) inputTokens += inputUsage;
      if (outputMeasured) outputTokens += outputUsage;
      if (cachedMeasured) cachedInputTokens += cachedUsage;
      cachedUsageComplete &&=
        cachedMeasured && response.usageComplete !== false;
      usageReported ||= inputMeasured || outputMeasured;
      tokenUsageComplete &&=
        inputMeasured && outputMeasured && response.usageComplete !== false;
      progress(
        "model",
        `Turn ${calls}/${maxTurns} · response received in ${((performance.now() - turnStarted) / 1000).toFixed(1)}s${tokenUsage(response)}`,
        "info",
        { detail: true },
      );
      const tokenLimitReached = response.tokenLimitReached;
      if (!response.complete && !tokenLimitReached)
        throw new Error("LLM response did not complete");
      if (tokenLimitReached)
        progress(
          "model",
          "Model output reached its token limit; the response may be incomplete",
          "warn",
        );
      return { response, tokenLimitReached };
    };

    /**
     * Dispatches one model tool call and returns its correlated output. Keeps a
     * stable ordinal across concurrent calls and reports only execution metadata.
     */
    const runTool = async (call: ModelToolCall) => {
      const toolNumber = ++toolCalls;
      const toolName = [...tools, ...capabilities.tools].some(
        (tool) => tool.type === "function" && tool.function.name === call.name,
      )
        ? call.name.slice(0, 200)
        : "unavailable tool";
      phase = `running ${toolName}`;
      const args = call.arguments;
      const summary =
        toolName === call.name
          ? toolProgressSummary(call.name, args)
          : undefined;
      const tool = {
        id: toolNumber,
        name: toolName.slice(0, 200),
        ...(summary ? { summary } : {}),
      };
      progress("tool", `Tool ${toolNumber} · ${toolName} started`, "info", {
        tool: { ...tool, status: "running" },
      });
      const toolStarted = performance.now();
      let result: string;
      let failed = false;
      let execution: Pick<
        NonNullable<ReviewProgress["tool"]>,
        "exitCode" | "timedOut" | "cancelled"
      > = {};
      try {
        if (verification.has(call.name)) {
          const output = await verification.call(call.name, args);
          result = JSON.stringify(output);
          failed = !output.ok;
          if (call.name === "exec" && "exitCode" in output)
            execution = {
              exitCode: output.exitCode,
              timedOut: output.timedOut,
              cancelled: output.cancelled,
            };
        } else if (call.name === "read_file") {
          result = await rtools.readFile(args);
        } else if (call.name === "read_diff") {
          result = activePrepared.read(args);
        } else {
          result = await capabilities.call(call.name, args);
        }
      } catch (e) {
        failed = true;
        result = verification.has(call.name)
          ? JSON.stringify({
              ok: false,
              error: { message: toolError(e) },
              durationMs: Math.round(performance.now() - toolStarted),
            })
          : toolError(e);
      }
      if (!config.conversation)
        evidence.record(`tool-${toolNumber}`, call.name, result, reviewStage);
      if (call.name === "read_diff") reportContext();
      progress(
        "tool",
        `Tool ${toolNumber} · ${toolName} ${failed ? "failed" : "finished"} in ${((performance.now() - toolStarted) / 1000).toFixed(1)}s · ${Buffer.byteLength(result)} bytes returned`,
        failed ? "warn" : "info",
        {
          tool: {
            ...tool,
            status: failed ? "failed" : "completed",
            durationMs: Math.round(performance.now() - toolStarted),
            ...execution,
          },
        },
      );
      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: call.id,
            toolName: call.name,
            output: { type: "text" as const, value: result },
          },
        ],
      };
    };

    /**
     * Validates final JSON and finding locations, allowing one correction turn when
     * budget remains. Returns undefined only when correction was requested.
     */
    const completedReview = async (
      response: ModelTurn,
      tokenLimitReached: boolean,
      lastTurn: boolean,
      challenge?: ReviewCheckpoint,
    ) => {
      phase = "validating the review result";
      progress(
        "result",
        config.conversation
          ? "Validating conversational response"
          : "Validating review and finding locations",
      );
      if (!response.text) throw new Error("LLM returned empty review JSON");
      let review: ReviewResult;
      try {
        review = parseReview(response.text, tokenLimitReached, config);
        await validateFindingLocations(
          review,
          rtools,
          repository,
          head,
          config,
          progress,
        );
        if (challenge) {
          const gaps = evidence.finalGaps(review, challenge);
          if (gaps.length) throw new IncompleteReviewError(gaps);
          const omitted = evidence.omittedSupportedCandidates(
            review,
            challenge,
          );
          if (omitted.length) {
            const limitation = `Finding limit reached: reported ${review.findings.length} findings; ${omitted.length} additional supported candidate(s) omitted because the review is limited to ${MAX_REVIEW_FINDINGS} findings.`;
            review.summary += `\n\n${limitation}`;
            progress("result", limitation, "warn");
          }
        }
      } catch (error) {
        if (outputRetries++ || lastTurn) throw error;
        if (error instanceof IncompleteReviewError)
          input.push({
            role: "user",
            content: `Final evidence gate gaps: ${JSON.stringify(error.gaps)}`,
          });
        progress(
          "result",
          "Invalid review output; requesting one corrected JSON response",
          "warn",
        );
        input.push({
          role: "user",
          content: await renderPrompt("correction", {
            conversational: !!config.conversation,
          }),
        });
        return undefined;
      }
      return review;
    };

    /** Runs one model turn and drains all tool batches before exposing its text output. */
    const turn = async (withoutTools = false) => {
      if (Buffer.byteLength(JSON.stringify(input)) > 1_300_000) {
        phase = "compacting review context";
        progress(
          "agent",
          "Compacting older model context while preserving instructions and the current checkpoint",
        );
        const preserved = new Set(retained);
        const compacted = await compactReviewContext({
          history: input.filter((message) => !preserved.has(message)),
          retained,
          knownEvidenceIds: new Set(evidence.records.map(({ id }) => id)),
          signal: config.signal,
          async generate(messages) {
            return (await requestTurn(true, messages)).response;
          },
        });
        input.splice(0, input.length, ...compacted);
        capabilities.resetContext();
        compactedEvidenceStart = evidence.records.length;
      }
      const { response, tokenLimitReached } = await requestTurn(withoutTools);
      input.push(...response.messages);
      const functionCalls = response.calls;
      if (withoutTools && functionCalls.length)
        throw new IncompleteReviewError([
          "The model requested tools during final serialization.",
        ]);
      if (!functionCalls.length) return { response, tokenLimitReached };
      if (functionCalls.length > 1)
        progress(
          "tool",
          `Turn ${calls}/${maxTurns} · ${functionCalls.length} tool calls requested · up to ${MAX_PARALLEL_TOOL_CALLS} independent reads at once`,
          "info",
          { detail: true },
        );
      for (let offset = 0; offset < functionCalls.length;) {
        config.signal?.throwIfAborted();
        const first = functionCalls[offset++]!;
        const batch = [first];
        if (parallelToolNames.has(first.name)) {
          while (
            batch.length < MAX_PARALLEL_TOOL_CALLS &&
            offset < functionCalls.length &&
            parallelToolNames.has(functionCalls[offset]!.name)
          )
            batch.push(functionCalls[offset++]!);
        }
        // Wait for every started call before advancing, executing a stateful
        // tool or closing capabilities. Preserve model order regardless of
        // completion order, including individual tool-error outputs.
        const outputs = await Promise.allSettled(batch.map(runTool));
        for (const output of outputs) {
          if (output.status === "rejected") throw output.reason;
          input.push(output.value);
        }
      }

      config.signal?.throwIfAborted();
      if (!config.conversation)
        input.push({
          role: "user",
          content: `Recorded evidence IDs for successful source pages and completed commands (not claims of semantic correctness): ${JSON.stringify(evidence.records)}`,
        });
      return undefined;
    };
    if (config.conversation) {
      while (calls < maxTurns) {
        const result = await turn();
        if (!result) continue;
        const review = await completedReview(
          result.response,
          result.tokenLimitReached,
          calls === maxTurns,
        );
        if (review) {
          finishReview(review);
          return review;
        }
      }
      throw new IncompleteReviewError([
        `Aggregate model-turn budget (${maxTurns}) exhausted before the reply completed.`,
      ]);
    }
    /** Runs the same evidence checkpoints for a bounded group or the final cross-file review. */
    const workflowOptions = {
      signal: config.signal,
      /** Emits checkpoint transitions without persisting model analysis. */
      progress(
        stage: ReviewStage | "final",
        state: "started" | "passed" | "revisit",
        gaps?: string[],
      ) {
        progress(
          "agent",
          `Review checkpoint · ${stage} · ${state}`,
          state === "revisit" ? "warn" : "info",
        );
        if (gaps?.length)
          progress(
            "agent",
            `Evidence gaps · ${gaps.join(" ")}`.slice(0, 1000),
            "warn",
            { detail: true },
          );
      },
      /** Advances one stage using the same conversation, tools and aggregate turn budget. */
      async checkpoint(
        stage: ReviewStage,
        previous?: ReviewCheckpoint,
        gaps?: string[],
      ) {
        if (reviewStage !== stage || !gaps)
          stageEvidenceStart = evidence.records.length;
        reviewStage = stage;
        phase = `running the ${stage} checkpoint`;
        const instruction: ModelMessage = {
          role: "user",
          content: await renderPrompt("review-stage", {
            stage,
            remainingTurns: Math.min(maxTurns, phaseTurnLimit) - calls,
            focus,
            environment,
            previous: previous ?? null,
            evidence: evidence.records,
            gaps: gaps ?? [],
          }),
        };
        input.push(instruction);
        retained = [...contextBase, instruction];
        while (true) {
          const result = await turn();
          if (!result) continue;
          if (result.tokenLimitReached)
            throw new IncompleteReviewError([
              `The ${stage} checkpoint reached the model output limit.`,
            ]);
          return result.response.text;
        }
      },
      /** Cross-checks stage claims against delivered evidence and diff coverage. */
      gaps(
        checkpoint: ReviewCheckpoint,
        stage: ReviewStage,
        previous?: ReviewCheckpoint,
      ) {
        const gaps = evidence.gaps(
          checkpoint,
          focus,
          activePrepared,
          stage,
          previous,
          Math.max(stageEvidenceStart, compactedEvidenceStart ?? 0),
        );
        if (crossGroupPass) {
          for (const candidate of groupedCandidates) {
            if (
              !checkpoint.candidates.some(
                (item) =>
                  item.path === candidate.path &&
                  item.lineStart <= candidate.lineStart &&
                  item.lineEnd >= candidate.lineEnd,
              )
            )
              gaps.push(
                `Reassess the group candidate at ${candidate.path}:${candidate.lineStart}; preserve it as supported, dismissed or unresolved.`,
              );
          }
        }
        if (
          stage === "challenge" &&
          (crossGroupPass || compactedEvidenceStart !== undefined)
        ) {
          const freshIds = new Set(
            evidence.records
              .slice(Math.max(stageEvidenceStart, compactedEvidenceStart ?? 0))
              .map(({ id }) => id),
          );
          for (const candidate of checkpoint.candidates.filter(
            (item) => item.status === "supported",
          )) {
            if (
              !evidence.covers(
                candidate.path,
                "head",
                candidate.lineStart,
                candidate.lineEnd,
                candidate.evidenceIds.filter((id) => freshIds.has(id)),
              )
            )
              gaps.push(
                `Reread the complete source range during final challenge for ${candidate.path}:${candidate.lineStart}-${candidate.lineEnd}.`,
              );
          }
        }
        return gaps;
      },
    };
    if (groups.length > 1) {
      if (maxTurns < groups.length * 4 + 4)
        throw new IncompleteReviewError([
          `The ${groups.length} review groups and final verification need more than the configured ${maxTurns}-turn aggregate budget.`,
        ]);
      const checkpoints: ReviewCheckpoint[] = [];
      const finalReserve = Math.min(
        24,
        Math.max(4, Math.floor(maxTurns / (groups.length + 1))),
      );
      const groupBudget = Math.min(
        24,
        Math.floor((maxTurns - finalReserve) / groups.length),
      );
      for (const [index, group] of groups.entries()) {
        activePrepared = group;
        phaseTurnLimit = Math.min(calls + groupBudget, maxTurns - finalReserve);
        focus = await selectReviewFocus(repository, group, config.signal);
        input.splice(0, input.length, ...instructions);
        capabilities.resetContext();
        input.push({
          role: "user",
          content: await renderPrompt("review-group", {
            index: index + 1,
            count: groups.length,
          }),
        });
        input.push({
          role: "user",
          content: await renderPrompt("diff", {
            conversational: false,
            base,
            head,
            baseline: group.baselineSha,
            mode: group.mode,
            manifest: group.manifest,
            diff: group.mode === "inline" ? group.patch : "",
          }),
        });
        group.markInlineSupplied();
        input.push({
          role: "user",
          content: `Review environment facts: ${JSON.stringify(environment)}`,
        });
        input.push({
          role: "system",
          content: await renderPrompt("review-focus", {
            sections: focus.sections,
            paths: focus.paths,
          }),
        });
        contextBase = [...input];
        retained = [...contextBase];
        progress(
          "agent",
          `Review group ${index + 1}/${groups.length} · ${group.files.length} files · up to ${groupBudget} model calls including compaction`,
        );
        checkpoints.push(
          await runReviewWorkflow<ReviewCheckpoint>({
            ...workflowOptions,
            outputSchema: checkpointSchema,
            /** Keeps each verified group checkpoint for the final cross-file pass. */
            async finalize(checkpoint) {
              return checkpoint;
            },
          }),
        );
      }
      groupedCandidates = checkpoints.flatMap(({ candidates }) =>
        candidates.filter(({ status }) => status !== "dismissed"),
      );
      if (groupedCandidates.length > 100)
        throw new IncompleteReviewError([
          "Combined group candidates exceed the bounded final verification capacity (100); no candidates were silently discarded.",
        ]);
      activePrepared = prepared;
      phaseTurnLimit = maxTurns;
      crossGroupPass = true;
      focus = await selectReviewFocus(repository, prepared, config.signal);
      input.splice(0, input.length, ...instructions);
      capabilities.resetContext();
      await appendReviewHistory(config, input, progress);
      input.push({
        role: "user",
        content: await renderPrompt("review-cross-group", {
          count: groups.length,
          baseline: prepared.baselineSha,
          head,
          manifest: prepared.manifest,
          checkpoints,
        }),
      });
      input.push({
        role: "user",
        content: `Review environment facts: ${JSON.stringify(environment)}`,
      });
      input.push({
        role: "system",
        content: await renderPrompt("review-focus", {
          sections: focus.sections,
          paths: focus.paths,
        }),
      });
      contextBase = [...input];
      retained = [...contextBase];
      checkpointLimitations = checkpoints.flatMap(
        ({ limitations }) => limitations,
      );
      progress(
        "agent",
        `Final cross-file verification · ${groups.length} groups · ${groupedCandidates.length} retained candidates`,
      );
    }
    const review = await runReviewWorkflow({
      ...workflowOptions,
      /** Serializes the challenged result, allowing the existing single JSON correction. */
      async finalize(challenge) {
        reviewStage = "final";
        checkpointLimitations = [
          ...checkpointLimitations,
          ...environment.limitations.filter((item) =>
            item.includes("unavailable"),
          ),
          ...challenge.limitations,
        ];
        const instruction: ModelMessage = {
          role: "user",
          content: await renderPrompt("review-final", {
            checkpoint: challenge,
            maxFindings: MAX_REVIEW_FINDINGS,
            environment,
            remainingTurns: maxTurns - calls,
          }),
        };
        input.push(instruction);
        retained = [...contextBase, instruction];
        while (true) {
          const result = await turn(true);
          if (!result) continue;
          const review = await completedReview(
            result.response,
            result.tokenLimitReached,
            calls === maxTurns,
            challenge,
          );
          if (review) return review;
        }
      },
    });
    finishReview(review);
    return review;
  } catch (error) {
    const reason = reviewFailure(error, config.signal);
    if (error instanceof IncompleteReviewError)
      progress(
        "result",
        `Review incomplete · ${error.gaps.join(" ")}`.slice(0, 1000),
        "error",
      );
    progress("result", `Review failed while ${phase} · ${reason}`, "error");
    logger.error(
      {
        reviewId: id,
        durationMs: Math.round(performance.now() - started),
        modelCalls: calls,
        toolCalls,
        error: "review execution failed",
      },
      "review failed",
    );
    throw error;
  } finally {
    await capabilities.close();
  }
}
