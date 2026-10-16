import type OpenAI from "openai";

import { renderPrompt } from "@harness/src/prompts.js";
import { executeCommand, type ExecOptions } from "@harness/src/tools/exec.js";
import {
  fetchUrl,
  searchWeb,
  type WebSearchProvider,
} from "@harness/src/tools/web.js";

export {
  executeCommand,
  execArguments,
  type ExecOptions,
} from "@harness/src/tools/exec.js";
export {
  fetchUrl,
  fetchUrlArguments,
  searchWeb,
  webSearchArguments,
  type WebSearchProvider,
  type WebSearchResult,
} from "@harness/src/tools/web.js";

export type VerificationOptions = {
  exec?: ExecOptions;
  webSearch?: WebSearchProvider;
};

export class VerificationTools {
  /**
   * Binds verification tools to the repository, caller-approved execution and search
   * options, and a shared cancellation signal.
   */
  constructor(
    private readonly repository: string,
    private readonly options: VerificationOptions = {},
    private readonly signal?: AbortSignal,
  ) {}

  /** Identifies the verification tool names handled by this dispatcher. */
  has(name: string) {
    return ["exec", "web_search", "fetch_url"].includes(name);
  }

  /**
   * Builds model-facing schemas and prompt descriptions for command execution, search,
   * and public URL fetching.
   */
  async definitions(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
    return [
      {
        type: "function",
        function: {
          name: "exec",
          description: await renderPrompt("tools/exec"),
          parameters: {
            type: "object",
            properties: {
              argv: {
                type: "array",
                items: {
                  type: "string",
                  maxLength: 16384,
                  pattern: String.raw`^[^\u0000]*$`,
                },
                minItems: 1,
                maxItems: 256,
              },
              cwd: {
                type: "string",
                maxLength: 16384,
                pattern: String.raw`^[^\u0000]*$`,
              },
              timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
              maxOutputBytes: { type: "integer", minimum: 1, maximum: 1000000 },
            },
            required: ["argv"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          description: await renderPrompt("tools/web-search"),
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 2000 },
              limit: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "fetch_url",
          description: await renderPrompt("tools/fetch-url"),
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", minLength: 1, maxLength: 8192 },
              timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
              maxOutputBytes: { type: "integer", minimum: 1, maximum: 100000 },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
    ];
  }

  /**
   * Checks cancellation and dispatches a recognized verification tool, rejecting
   * unknown names.
   */
  async call(name: string, input: unknown) {
    this.signal?.throwIfAborted();
    if (name === "exec")
      return executeCommand(
        this.repository,
        input,
        this.options.exec,
        this.signal,
      );
    if (name === "web_search")
      return searchWeb(input, this.options.webSearch, this.signal);
    if (name === "fetch_url") return fetchUrl(input, this.signal);
    throw new Error("unknown verification tool");
  }
}
