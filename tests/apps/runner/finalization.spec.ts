import assert from "node:assert/strict";
import { access, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import pino, { type Logger } from "pino";

import {
  capabilityLimitsSchema,
  mergePolicySchema,
  type MergeAssessment,
} from "@razbor/contracts";
import { reviewRepository, type ReviewConfig } from "@razbor/harness";
import { RemoteMemory } from "@razbor/harness/mcp";
import { runnerConfigSchema } from "@razbor/runner/config";
import { ModelRelay } from "@razbor/runner/relay";

import { diffFixture } from "@tests/packages/harness/diff-fixture.js";

type Provider = "openai" | "anthropic";

type Payload = Record<string, unknown>;

type Reply = {
  text?: string;
  truncated?: boolean;
  call?:
    | { id: string; argv: string[]; maxOutputBytes?: number }
    | { id: string; name: "read_diff" | "read_file"; args: Payload };
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
  const args =
    reply.call &&
    ("args" in reply.call
      ? reply.call.args
      : {
          argv: reply.call.argv,
          ...(reply.call.maxOutputBytes
            ? { maxOutputBytes: reply.call.maxOutputBytes }
            : {}),
        });
  const name = reply.call && "name" in reply.call ? reply.call.name : "exec";
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
                  name,
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
                  name,
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

const readyAssessment: MergeAssessment = {
  confidence: 95,
  riskLevel: "low",
  reviewComplete: true,
  requiresHumanReview: false,
  reasons: ["Inspected the changed line in source.ts."],
  criticalAreas: [],
  verificationGaps: [],
  suggestedReviewers: [],
};

for (const indexed of [false, true]) {
  test(
    (indexed ? "indexed" : "source-only") +
      " review requires the policy assessment and derives rename owners from the pinned Git comparison",
    async (t) => {
      const graph = t.mock.method(
        RemoteMemory.prototype,
        "start",
        async function (this: RemoteMemory) {
          this.tools = [
            { name: "search_graph", inputSchema: { type: "object" } },
          ];
        },
      );
      const f = await fixture(t, "openai", [
        (payload) => {
          const prompts = JSON.stringify(payload.input);
          assert.match(prompts, /Require review for provider credentials/);
          assert.match(prompts, /uncalibrated assessment/);
          assert.match(prompts, /security-owner/);
          assert.equal(
            JSON.stringify(payload.tools).includes("cbm_search_graph"),
            indexed,
          );
          return { text: JSON.stringify(result) };
        },
        (payload) => {
          assert.match(
            JSON.stringify(payload.input),
            /only correction attempt/,
          );
          return {
            text: JSON.stringify({
              ...result,
              mergeAssessment: {
                ...readyAssessment,
                pathOwners: indexed ? ["security-owner"] : "security-owner",
              },
            }),
          };
        },
      ]);
      await mkdir(path.join(f.files.repository, "db"));
      await rename(
        path.join(f.files.repository, "related.ts"),
        path.join(f.files.repository, "db/schema.sql"),
      );
      f.files.head = await f.files.commit();
      const returned = await f.review({
        mergePolicy: {
          version: 7,
          policy: mergePolicySchema.parse({
            policyMarkdown: "Require review for provider credentials.",
            humanReviewers: [
              {
                username: "security-owner",
                responsibilities: "Provider credentials",
                pathPatterns: ["credentials/**"],
              },
              {
                username: "database-owner",
                responsibilities: "Database schemas",
                pathPatterns: ["db/**"],
              },
              {
                username: "previous-owner",
                responsibilities: "Changes to the original module",
                pathPatterns: ["related.ts"],
              },
            ],
          }),
        },
        capabilities: {
          instructions: [],
          skills: [],
          limits: capabilityLimitsSchema.parse({}),
          ...(indexed
            ? {
                codebaseMemory: {
                  endpoint: "http://cbm.invalid/mcp",
                  tokenEnv: "RAZBOR_MCP_TOKEN",
                  project: "ws_abcdefghijklmnop",
                  indexHeadSha: f.files.head,
                  indexBranch: "main",
                  startupMs: 100,
                  queryMs: 100,
                },
              }
            : {}),
        },
      });
      assert.deepEqual(returned.mergeAssessment, {
        ...readyAssessment,
        pathOwners: ["database-owner", "previous-owner"],
      });
      assert.equal(graph.mock.callCount(), indexed ? 1 : 0);
      assert.equal(f.calls, 2);
    },
  );
}

test("an exec inspection of the pinned lazy diff retains the complete assessment", async (t) => {
  const f = await fixture(t, "openai", [
    () => ({
      call: {
        id: "inspect",
        argv: ["git", "diff", f.files.base, f.files.head],
      },
    }),
    (payload) => {
      assert.match(
        JSON.stringify(toolBlocks("openai", payload)),
        /new implementation/,
      );
      return {
        text: JSON.stringify({ ...result, mergeAssessment: readyAssessment }),
      };
    },
  ]);
  const returned = await f.review({
    initialDiffMaxBytes: 0,
    mergePolicy: { version: 1, policy: mergePolicySchema.parse({}) },
  });
  assert.match(returned.summary, /optional diff delivery/);
  assert.deepEqual(returned.mergeAssessment, readyAssessment);
});

test("binary content and truncated exec evidence still downgrade a complete assessment", async (t) => {
  const f = await fixture(t, "openai", [
    () => ({
      call: {
        id: "verification",
        argv: ["cat", "source.ts"],
        maxOutputBytes: 8,
      },
    }),
    (payload) => {
      const observation = String(toolBlocks("openai", payload).at(-1)?.output);
      assert.ok(
        observation.includes('"truncated":true'),
        observation.slice(-520),
      );
      return {
        text: JSON.stringify({ ...result, mergeAssessment: readyAssessment }),
      };
    },
  ]);
  await f.files.write("asset.bin", Buffer.from([0, 1, 2, 255]));
  f.files.head = await f.files.commit();
  const returned = await f.review({
    initialDiffMaxBytes: 0,
    mergePolicy: { version: 1, policy: mergePolicySchema.parse({}) },
  });
  assert.equal(returned.mergeAssessment?.reviewComplete, false);
  assert.equal(returned.mergeAssessment?.requiresHumanReview, true);
  assert.match(
    returned.mergeAssessment!.verificationGaps.join(" "),
    /Tool evidence was truncated/,
  );
  assert.match(
    returned.mergeAssessment!.verificationGaps.join(" "),
    /1 binary/,
  );
});

test("failed verification is retained even when the model claims full merge readiness", async (t) => {
  const f = await fixture(t, "openai", [
    () => ({
      call: {
        id: "verification",
        argv: [process.execPath, "-e", "process.exit(1)"],
      },
    }),
    (payload) => {
      assert.match(
        String(toolBlocks("openai", payload).at(-1)?.output),
        /"exitCode":1\b/,
      );
      return {
        text: JSON.stringify({ ...result, mergeAssessment: readyAssessment }),
      };
    },
  ]);
  const returned = await f.review({
    mergePolicy: { version: 1, policy: mergePolicySchema.parse({}) },
  });
  assert.equal(returned.mergeAssessment?.reviewComplete, false);
  assert.equal(returned.mergeAssessment?.requiresHumanReview, true);
  assert.match(
    returned.mergeAssessment!.verificationGaps.join(" "),
    /exec tool failed/,
  );
});

for (const scenario of [
  "partial diff",
  "full diff by exec",
  "short source",
  "partial source",
  "finished source",
  "full source by exec",
] as const) {
  test("merge assessment coverage for " + scenario, async (t) => {
    const diff = scenario.includes("diff");
    const steps: ((payload: Payload) => Reply)[] = [
      () => ({
        call: diff
          ? { name: "read_diff", id: "page", args: { paths: ["source.ts"] } }
          : {
              name: "read_file",
              id: "page",
              args: {
                path: "source.ts",
                startLine: 1,
                endLine: scenario === "short source" ? 20 : 800,
              },
            },
      }),
    ];
    if (scenario === "finished source")
      steps.push(() => ({
        call: {
          name: "read_file",
          id: "rest",
          args: { path: "source.ts", startLine: 401, endLine: 800 },
        },
      }));
    if (scenario === "partial diff" || scenario === "partial source")
      steps.push(() => ({
        call: { id: "unrelated", argv: ["git", "status", "--short"] },
      }));
    if (scenario.includes("by exec"))
      steps.push(() => ({
        call: {
          id: "rest",
          argv: diff
            ? ["git", "diff", f.files.base, f.files.head]
            : ["git", "show", f.files.head + ":source.ts"],
        },
      }));
    steps.push((payload) => {
      const block = toolBlocks("openai", payload).find(
        (b) => b.call_id === "page" && b.type === "function_call_output",
      );
      const observed = String(block?.output);
      if (diff) assert.match(observed, /"remaining":true/);
      else
        assert.match(
          observed,
          scenario === "short source" ? /"endLine":20,/ : /"endLine":400,/,
        );
      return {
        text: JSON.stringify({ ...result, mergeAssessment: readyAssessment }),
      };
    });
    const f = await fixture(t, "openai", steps);
    await f.files.write(
      "source.ts",
      Array.from({ length: 900 }, (_, i) => "line " + i).join("\n") + "\n",
    );
    f.files.head = await f.files.commit();
    const returned = await f.review({
      initialDiffMaxBytes: 0,
      capabilities: {
        instructions: [],
        skills: [],
        limits: capabilityLimitsSchema.parse({ toolOutputBytes: 4096 }),
      },
      verification: { exec: { maxOutputBytes: 24_000 } },
      mergePolicy: { version: 1, policy: mergePolicySchema.parse({}) },
    });
    assert.equal(
      returned.mergeAssessment?.reviewComplete,
      !scenario.startsWith("partial"),
    );
  });
}
