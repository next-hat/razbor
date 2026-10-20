import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent, type ToolsInput } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { createTool } from "@mastra/core/tools";
import { APICallError, jsonSchema, type ModelMessage } from "ai";
import type OpenAI from "openai";
import {
  Agent as UndiciAgent,
  Dispatcher1Wrapper,
  type RequestInit as UndiciRequestInit,
} from "undici";

import type { ModelProvider, ReasoningEffort } from "@razbor/contracts";

// The relay and attempt signal own finite model deadlines, including long waits
// for response headers; native Node fetch needs Undici's legacy protocol wrapper.
const modelDispatcher = new Dispatcher1Wrapper(
  new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 }),
);

/** Preserve SDK cancellation while allowing the relay's configured model deadline. */
async function fetchModel(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, {
    ...init,
    dispatcher: modelDispatcher,
  } as RequestInit & Pick<UndiciRequestInit, "dispatcher">);
}

export type ModelToolCall = { id: string; name: string; arguments: unknown };

export type ModelTurn = {
  text: string;
  calls: ModelToolCall[];
  messages: ModelMessage[];
  complete: boolean;
  tokenLimitReached: boolean;
  /** False when relay retries may have consumed tokens absent from the final response. */
  usageComplete?: boolean;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    uncachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
  };
};

export class ModelRequestError extends Error {
  /** Retains only safe status information, never provider bodies, prompts or keys. */
  constructor(readonly status?: number) {
    super(`Model request failed${status ? ` (HTTP ${status})` : ""}`);
  }
}

/** Finds a wrapped SDK HTTP status without copying provider request or response data. */
function modelStatus(error: unknown): number | undefined {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++) {
    if (APICallError.isInstance(error)) return error.statusCode;
    error = error.cause;
  }
  return undefined;
}

/**
 * Preserve absent cache measurements instead of the SDK's inferred zero. Mastra
 * retains the native usage under the normalized V4 usage's raw field.
 */
export function measuredUsage(
  provider: ModelProvider,
  usage: ModelTurn["usage"] & { raw?: unknown },
  body?: unknown,
): ModelTurn["usage"] {
  const wrapped = usage.raw as { raw?: unknown } | undefined;
  const native = (wrapped?.raw ??
    usage.raw ??
    (body as { usage?: unknown } | undefined)?.usage) as
    | {
        input_tokens?: unknown;
        input_tokens_details?: { cached_tokens?: unknown } | null;
        cache_read_input_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
      }
    | undefined;
  const cached =
    provider === "openai"
      ? native?.input_tokens_details?.cached_tokens
      : native?.cache_read_input_tokens;
  const writes =
    provider === "openai" ? 0 : native?.cache_creation_input_tokens;
  /** Preserves absent or invalid native counts rather than manufacturing a zero. */
  const measured = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  const inputTokens = measured(usage.inputTokens);
  let cachedInputTokens = measured(cached);
  let cacheWriteTokens = measured(writes);
  let uncachedInputTokens =
    provider === "anthropic"
      ? measured(native?.input_tokens)
      : inputTokens !== undefined &&
          cachedInputTokens !== undefined &&
          cachedInputTokens <= inputTokens
        ? inputTokens - cachedInputTokens
        : undefined;
  if (
    inputTokens !== undefined &&
    ((cachedInputTokens !== undefined && cachedInputTokens > inputTokens) ||
      (cacheWriteTokens !== undefined && cacheWriteTokens > inputTokens) ||
      (cachedInputTokens !== undefined &&
        cacheWriteTokens !== undefined &&
        cachedInputTokens + cacheWriteTokens > inputTokens) ||
      (uncachedInputTokens !== undefined &&
        cachedInputTokens !== undefined &&
        cacheWriteTokens !== undefined &&
        uncachedInputTokens + cachedInputTokens + cacheWriteTokens !==
          inputTokens))
  ) {
    cachedInputTokens = undefined;
    cacheWriteTokens = undefined;
    uncachedInputTokens = undefined;
  }
  return {
    inputTokens,
    outputTokens: measured(usage.outputTokens),
    cachedInputTokens,
    uncachedInputTokens,
    cacheWriteTokens,
  };
}

/**
 * Checks both SDK and native completion markers. In particular, Anthropic pause_turn
 * normalizes to stop but still requires continuation, and filtered JSON is incomplete.
 */
function modelCompletion(
  provider: ModelProvider,
  finishReason: string | undefined,
  body: unknown,
) {
  const native =
    body && typeof body === "object"
      ? (body as {
          status?: unknown;
          incomplete_details?: { reason?: unknown } | null;
          stop_reason?: unknown;
        })
      : undefined;
  const complete =
    (finishReason === "stop" || finishReason === "tool-calls") &&
    (provider === "openai"
      ? native?.status === "completed"
      : ["end_turn", "stop_sequence", "tool_use"].includes(
          String(native?.stop_reason),
        ));
  const tokenLimitReached =
    finishReason === "length" &&
    (provider === "openai"
      ? native?.status === "incomplete" &&
        native.incomplete_details?.reason === "max_output_tokens"
      : ["max_tokens", "model_context_window_exceeded"].includes(
          String(native?.stop_reason),
        ));
  return { complete, tokenLimitReached };
}

/**
 * Creates a stateless Mastra agent on the attempt-scoped relay. Tools have no execute
 * handlers: the harness owns ordering, concurrency, evidence and cancellation.
 */
export function createReviewModel(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: ModelProvider;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}) {
  const provider = config.provider ?? "openai";
  const settings = {
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    fetch: fetchModel,
  };
  const model =
    provider === "anthropic"
      ? createAnthropic(settings)(config.model)
      : createOpenAI(settings).responses(config.model);
  const agent = new Agent({
    id: "razbor-review",
    name: "Razbor review",
    instructions: "",
    model,
  });
  // The existing progress stream is the only log sink. Do not emit SDK payloads.
  agent.__setLogger(noopLogger);
  return {
    /** Executes one capped model step with no SDK retries. */
    async generate(
      messages: ModelMessage[],
      definitions: OpenAI.Chat.Completions.ChatCompletionTool[],
      toolChoice: "auto" | "none" | undefined,
    ): Promise<ModelTurn> {
      const clientTools: ToolsInput = {};
      for (const definition of definitions) {
        if (definition.type !== "function") continue;
        const tool = definition.function;
        clientTools[tool.name] = createTool({
          id: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: jsonSchema(
            tool.parameters ?? { type: "object", properties: {} },
          ),
        });
      }
      config.signal?.throwIfAborted();
      try {
        const result = await agent.generate(messages, {
          maxSteps: 1,
          maxProcessorRetries: 0,
          modelSettings: {
            maxRetries: 0,
            maxOutputTokens: config.maxOutputTokens ?? 4096,
          },
          abortSignal: config.signal,
          toolCallConcurrency: 4,
          ...(toolChoice === undefined ? {} : { clientTools, toolChoice }),
          providerOptions:
            provider === "openai"
              ? {
                  openai: {
                    store: false,
                    include: ["reasoning.encrypted_content"],
                    reasoningEffort: config.reasoningEffort,
                    ...(toolChoice === undefined
                      ? {}
                      : { parallelToolCalls: true }),
                  },
                }
              : {},
        });
        config.signal?.throwIfAborted();
        if (result.error) throw result.error;
        if (result.tripwire || result.finishReason === "error")
          throw new Error("Model response did not complete");
        return {
          text: result.text,
          calls: result.toolCalls.map(({ payload }) => {
            if (payload.providerExecuted)
              throw new Error("Unexpected provider-executed tool");
            return {
              id: payload.toolCallId,
              name: payload.toolName,
              arguments: payload.args,
            };
          }),
          // Mastra preserves the SDK's provider metadata, including stateless encrypted reasoning.
          messages: result.response.messages ?? [],
          ...modelCompletion(
            provider,
            result.finishReason,
            result.response.body,
          ),
          usageComplete:
            result.response.headers?.["x-razbor-usage-incomplete"] === "true"
              ? false
              : undefined,
          usage: measuredUsage(provider, result.usage, result.response.body),
        };
      } catch (error) {
        config.signal?.throwIfAborted();
        throw new ModelRequestError(modelStatus(error));
      }
    },
  };
}
