import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import pino, { type Logger } from "pino";

import { reviewRepository, type ReviewConfig } from "@razbor/harness";
import { runnerConfigSchema } from "@razbor/runner/config";
import { ModelRelay } from "@razbor/runner/relay";

import { diffFixture } from "@tests/packages/harness/diff-fixture.js";

type Provider = "openai" | "anthropic";

type Payload = Record<string, unknown>;

type Reply = {
  text?: string;
  truncated?: boolean;
  call?: { id: string; argv: string[]; maxOutputBytes?: number };
};

const result = {
  prSummary: {
    title: "Update fixture behavior",
    description: "Changes source.ts behavior in the fixture.",
    labels: ["refactor"],
    diagram: null,
  },
  summary: "No actionable findings in inspected source; no tests executed.",
  findings: [],
};

/** Encodes deterministic native provider replies without invoking an external service. */
function nativeResponse(
  provider: Provider,
  reply: Reply,
  turn: number,
): Response {
  const args = reply.call && {
    argv: reply.call.argv,
    ...(reply.call.maxOutputBytes
      ? { maxOutputBytes: reply.call.maxOutputBytes }
      : {}),
  };
  const body =
    provider === "anthropic"
      ? {
          id: "msg_fixture_" + turn,
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: reply.call
            ? [
                {
                  type: "tool_use",
                  id: reply.call.id,
                  name: "exec",
                  input: args,
                },
              ]
            : [{ type: "text", text: reply.text ?? JSON.stringify(result) }],
          stop_reason: reply.truncated
            ? "max_tokens"
            : reply.call
              ? "tool_use"
              : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }
      : {
          id: "resp_fixture_" + turn,
          object: "response",
          created_at: 0,
          status: reply.truncated ? "incomplete" : "completed",
          ...(reply.truncated
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
          model: "fixture-model",
          output: reply.call
            ? [
                {
                  id: "function_" + turn,
                  type: "function_call",
                  status: "completed",
                  call_id: reply.call.id,
                  name: "exec",
                  arguments: JSON.stringify(args),
                },
              ]
            : [
                {
                  id: "message_" + turn,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: reply.text ?? JSON.stringify(result),
                      annotations: [],
                    },
                  ],
                },
              ],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** Returns actual serialized tool blocks, excluding tool history quoted inside compaction text. */
function toolBlocks(provider: Provider, payload: Payload): Payload[] {
  if (provider === "openai")
    return (payload.input as Payload[]).filter((item) =>
      ["function_call", "function_call_output"].includes(String(item.type)),
    );
  return (payload.messages as { content: unknown }[]).flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Payload[]).filter((item) =>
          ["tool_use", "tool_result"].includes(String(item.type)),
        )
      : [],
  );
}

/** Checks history correlation and explicit generation policy at the native provider boundary. */
function assertFinalization(
  provider: Provider,
  payload: Payload,
  definitions: unknown,
) {
  const blocks = toolBlocks(provider, payload);
  assert.equal(blocks.length, 2);
  assert.equal(
    provider === "openai" ? blocks[0].call_id : blocks[0].id,
    "inspect",
  );
  assert.equal(
    provider === "openai" ? blocks[1].call_id : blocks[1].tool_use_id,
    "inspect",
  );
  assert.match(JSON.stringify(blocks[1]), /new implementation/);
  assert.ok(
    isDeepStrictEqual(payload.tools, definitions),
    "definitions must remain stable while retained history contains a tool use/result pair",
  );
  assert.deepEqual(
    payload.tool_choice,
    provider === "anthropic" ? { type: "none" } : "none",
  );
}

/** Routes the real harness adapter through the real relay and intercepts only native provider I/O. */
async function fixture(
  t: TestContext,
  provider: Provider,
  steps: ((payload: Payload) => Reply)[],
) {
  const files = await diffFixture();
  const config = runnerConfigSchema.parse({
    model: { provider, max_retries: 0 },
  });
  const relay = new ModelRelay({
    ...config,
    endpoint:
      "http://provider.invalid/v1/" +
      (provider === "anthropic" ? "messages" : "responses"),
    apiKey: "provider-fixture-key",
    model: { ...config.model, model: "fixture-model" },
  });
  const capability = relay.issue(new AbortController().signal);
  const globals = globalThis as typeof globalThis & { razborLogger?: Logger };
  const prior = globals.razborLogger;
  globals.razborLogger = pino({ enabled: false });
  let calls = 0;
  let assertion: unknown;
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "relay.invalid")
        return relay.handleRequest(new Request(input, init));
      assert.equal(url.hostname, "provider.invalid");
      try {
        const payload = JSON.parse(String(init?.body));
        const step = steps[calls++];
        assert.ok(step, "Unexpected provider dispatch");
        return nativeResponse(provider, step(payload), calls);
      } catch (error) {
        assertion = error;
        throw error;
      }
    },
  );
  t.after(async () => {
    fetch.mock.restore();
    globals.razborLogger = prior;
    capability.revoke();
    await relay.close();
    await files.close();
  });
  return {
    files,
    /** Counts intercepted native provider dispatches, including compaction. */
    get calls() {
      return calls;
    },
    /** Preserves assertion errors hidden by the model adapter's safe public error category. */
    async review(options: Partial<ReviewConfig> = {}) {
      try {
        return await reviewRepository(
          files.repository,
          files.base,
          files.head,
          {
            baseUrl: "http://relay.invalid/v1",
            apiKey: capability.token,
            provider,
            model: "fixture-model",
            reasoningEffort: "low",
            reviewId: "fixture",
            ...options,
          },
        );
      } catch (error) {
        throw assertion ?? error;
      }
    },
  };
}

for (const provider of ["openai", "anthropic"] as const) {
  test(
    provider +
      " finalization keeps stable tool definitions alongside prior tool history",
    async (t) => {
      let definitions: unknown;
      const f = await fixture(t, provider, [
        (payload) => {
          definitions = payload.tools;
          assert.ok(Array.isArray(definitions) && definitions.length);
          return { call: { id: "inspect", argv: ["cat", "source.ts"] } };
        },
        (payload) => {
          assertFinalization(provider, payload, definitions);
          return {};
        },
      ]);
      assert.equal((await f.review({ maxTurns: 2 })).findings.length, 0);
      assert.equal(f.calls, 2);
    },
  );

  test(
    provider +
      " truncated-output correction retains definitions and disables new tool calls",
    async (t) => {
      let definitions: unknown;
      const f = await fixture(t, provider, [
        (payload) => {
          definitions = payload.tools;
          return { call: { id: "inspect", argv: ["cat", "source.ts"] } };
        },
        (payload) => {
          assertFinalization(provider, payload, definitions);
          return { text: '{"summary":', truncated: true };
        },
        (payload) => {
          assertFinalization(provider, payload, definitions);
          assert.match(JSON.stringify(payload), /only correction attempt/);
          return {};
        },
      ]);
      assert.equal(
        (await f.review({ maxTurns: 3, reviewBudget: { maxToolCalls: 1 } }))
          .findings.length,
        0,
      );
      assert.equal(f.calls, 3);
    },
  );

  test(
    provider + " a malicious finalization tool call never executes",
    async (t) => {
      let marker = "";
      const f = await fixture(t, provider, [
        () => ({ call: { id: "inspect", argv: ["cat", "source.ts"] } }),
        () => ({
          call: {
            id: "forbidden",
            argv: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(" +
                JSON.stringify(marker) +
                ", 'executed')",
            ],
          },
        }),
      ]);
      marker = path.join(f.files.repository, "finalization-must-not-execute");
      await assert.rejects(
        f.review({ maxTurns: 2 }),
        /Model requested investigation tools/,
      );
      await assert.rejects(access(marker), { code: "ENOENT" });
      assert.equal(f.calls, 2);
    },
  );

  test(
    provider +
      " independent compaction requests carry neither tool schemas nor live tool history",
    async (t) => {
      let definitions: unknown;
      const f = await fixture(t, provider, [
        (payload) => {
          definitions = payload.tools;
          return {
            call: {
              id: "inspect",
              argv: [
                process.execPath,
                "-e",
                "process.stdout.write('compaction-output-marker'.repeat(3500))",
              ],
              maxOutputBytes: 100000,
            },
          };
        },
        (payload) => {
          assert.match(JSON.stringify(payload), /transcriptFragment/);
          assert.ok(
            payload.tools === undefined ||
              (Array.isArray(payload.tools) && payload.tools.length === 0),
          );
          assert.equal(toolBlocks(provider, payload).length, 0);
          return {
            text: JSON.stringify({
              notes:
                "tool-1 returned command text; source inspection remains unresolved. No tests ran.",
              evidenceIds: ["tool-1"],
            }),
          };
        },
        (payload) => {
          assert.ok(
            isDeepStrictEqual(payload.tools, definitions),
            "normal review resumes with the same tool definitions after compaction",
          );
          assert.deepEqual(
            payload.tool_choice,
            provider === "anthropic" ? { type: "none" } : "none",
          );
          assert.equal(toolBlocks(provider, payload).length, 0);
          assert.doesNotMatch(
            JSON.stringify(payload),
            /compaction-output-marker/,
          );
          return {};
        },
      ]);
      assert.equal(
        (
          await f.review({
            maxTurns: 3,
            compactionThresholdTokens: 12000,
            verification: { exec: { maxOutputBytes: 100000 } },
          })
        ).findings.length,
        0,
      );
      assert.equal(f.calls, 3);
    },
  );
}
