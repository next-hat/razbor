import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client, type Tool } from "@modelcontextprotocol/client";
import pino from "pino";

import {
  capabilityLimitsSchema,
  reviewResultSchema,
  type PreparedCapabilities,
} from "@razbor/contracts";
import { SkillCatalog } from "@razbor/harness/skills";
import {
  BoundTools,
  RemoteMemory,
  readOnlyTools,
  resultText,
} from "@razbor/harness/mcp";
import { ReviewCapabilities } from "@razbor/harness/capabilities";
import { boundedText, boundedOutput } from "@razbor/harness/capability-files";

const log = pino({ enabled: false });

test("skills are lazy, deterministic and confined; repeated bodies are omitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-skills-"));
  try {
    const skill = path.join(root, "correctness");
    await mkdir(skill);
    await writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: correctness\ndescription: Check function correctness\n---\nPrivate skill body",
    );
    await writeFile(path.join(skill, "notes.txt"), "Referenced guidance");
    await symlink("/etc/passwd", path.join(skill, "escape.md"));
    const catalog = new SkillCatalog(capabilityLimitsSchema.parse({}), log);
    await catalog.discover([root]);
    assert.deepEqual(
      JSON.parse(catalog.find({ query: "function" })).skills.map(
        (s: { id: string }) => s.id,
      ),
      ["correctness"],
    );
    assert.doesNotMatch(
      catalog.find({ query: "function" }),
      /Private skill body/,
    );
    assert.match(
      await catalog.read({ id: "correctness" }),
      /Private skill body/,
    );
    assert.equal(
      JSON.parse(await catalog.read({ id: "correctness" })).alreadyLoaded,
      true,
    );
    assert.match(
      await catalog.read({ id: "correctness", resource: "notes.txt" }),
      /Referenced guidance/,
    );
    for (const input of [
      { id: "missing" },
      { id: "correctness", resource: "../secret.md" },
      { id: "correctness", resource: "/etc/passwd" },
      { id: "correctness", resource: "escape.md" },
      { id: "correctness", resource: "script.sh" },
    ])
      await assert.rejects(catalog.read(input));
    await assert.rejects(
      new SkillCatalog(capabilityLimitsSchema.parse({}), log).discover([
        root,
        root,
      ]),
      /duplicate/,
    );
    await writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: invalid name\n---\nbody",
    );
    await assert.rejects(
      new SkillCatalog(capabilityLimitsSchema.parse({}), log).discover([root]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP uses discovered schemas, rejects mutations and binds every project", () => {
  const discovered: Tool[] = [...readOnlyTools, "delete_project"].map(
    (name) => ({
      name,
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          limit: { type: "integer", maximum: 10 },
        },
        required: ["project"],
      },
    }),
  );
  const bound = new BoundTools(discovered, "review-fixed");
  assert.equal(bound.tools.length, readOnlyTools.length);
  assert.equal(
    bound.tools.some((tool) => tool.name === "delete_project"),
    false,
  );
  assert.deepEqual(bound.arguments("search_graph", { limit: 3 }), {
    project: "review-fixed",
    limit: 3,
  });
  for (const args of [
    { project: "other" },
    { project_name: "other" },
    { limit: 11 },
    { repo_path: "/etc" },
  ])
    assert.throws(() => bound.arguments("search_graph", args));
  assert.throws(() => bound.arguments("delete_project", {}));
  assert.throws(() => new BoundTools([], "review-fixed"), /missing/);
  assert.throws(
    () =>
      resultText({
        isError: true,
        content: [{ type: "text", text: "private error" }],
      }),
    /not an empty result/,
  );
  assert.equal(
    resultText({
      structuredContent: { total: 0 },
      content: [{ type: "text", text: '{"total":0}' }],
    }),
    '{"total":0}',
  );
  assert.equal(
    resultText({
      content: [{ type: "resource_link", uri: "https://example.com/private" }],
    }),
    "",
  );
});

test("disabled capabilities and final-result validation remain intact", async () => {
  const capabilities = new ReviewCapabilities(
    undefined,
    log,
    new AbortController().signal,
  );
  await capabilities.start();
  assert.deepEqual(capabilities.tools, []);
  assert.deepEqual(capabilities.instructions, []);
  await assert.rejects(
    capabilities.call("find_skill", { query: "anything" }),
    /disabled/,
  );
  await capabilities.close();
  assert.throws(() =>
    reviewResultSchema.parse({
      summary: "invalid",
      findings: [{ severity: "urgent" }],
    }),
  );
  assert.deepEqual(
    reviewResultSchema.parse({ summary: "valid", findings: [] }),
    { summary: "valid", findings: [] },
  );
});

/** Build approved optional connections without requiring a live MCP server. */
function optionalCapabilities(): PreparedCapabilities {
  return {
    instructions: [],
    skills: [],
    limits: capabilityLimitsSchema.parse({}),
    codebaseMemory: {
      endpoint: "http://private-endpoint.invalid/mcp",
      tokenEnv: "RAZBOR_MCP_TOKEN",
      project: "private-project",
      indexHeadSha: "a".repeat(40),
      indexBranch: "private-branch",
      startupMs: 100,
      queryMs: 100,
    },
    mcpServers: [
      {
        id: "private-server",
        name: "private-name",
        endpoint: "http://private-endpoint.invalid/mcp",
        tokenEnv: "RAZBOR_MCP_TOKEN",
        startupMs: 100,
        queryMs: 100,
      },
      {
        id: "working-server",
        name: "working-server",
        endpoint: "http://private-endpoint.invalid/mcp",
        tokenEnv: "RAZBOR_MCP_TOKEN",
        startupMs: 100,
        queryMs: 100,
      },
    ],
    memory: {
      endpoint: "http://private-endpoint.invalid/memory",
      tokenEnv: "RAZBOR_MEMORY_TOKEN",
      queryMs: 100,
    },
  };
}

test("unavailable optional services close partial clients and expose sanitized limitations", async (t) => {
  const originalMcpToken = process.env.RAZBOR_MCP_TOKEN;
  const originalMemoryToken = process.env.RAZBOR_MEMORY_TOKEN;
  process.env.RAZBOR_MCP_TOKEN = "fixture-token";
  delete process.env.RAZBOR_MEMORY_TOKEN;
  t.after(() => {
    if (originalMcpToken === undefined) delete process.env.RAZBOR_MCP_TOKEN;
    else process.env.RAZBOR_MCP_TOKEN = originalMcpToken;
    if (originalMemoryToken === undefined)
      delete process.env.RAZBOR_MEMORY_TOKEN;
    else process.env.RAZBOR_MEMORY_TOKEN = originalMemoryToken;
  });
  const observedLogs: string[] = [];
  const localLog = pino(
    {},
    {
      write: (chunk: string) => {
        observedLogs.push(chunk);
      },
    },
  );
  let graphClosed = 0;
  t.mock.method(
    RemoteMemory.prototype,
    "start",
    async function (this: RemoteMemory) {
      this.tools = [
        { name: "partial-graph-tool", inputSchema: { type: "object" } },
      ];
      throw new Error("private-startup-error fixture-token");
    },
  );
  t.mock.method(RemoteMemory.prototype, "close", async () => {
    graphClosed++;
  });
  let closed = 0;
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {
    closed++;
  });
  let discoveries = 0;
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools:
      ++discoveries === 1
        ? [
            {
              name: "a-partial",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "z-invalid",
              inputSchema: {
                type: "object",
                $schema: "private-unsupported-dialect",
              },
            },
          ]
        : [
            {
              name: "inspect",
              inputSchema: { type: "object", properties: {} },
            },
          ],
  }));
  t.mock.method(Client.prototype, "callTool", async () => ({
    structuredContent: { observed: true },
  }));
  const capabilities = new ReviewCapabilities(
    optionalCapabilities(),
    localLog,
    new AbortController().signal,
  );
  await capabilities.start();
  assert.equal(graphClosed, 1);
  assert.equal(closed, 1);
  assert.equal(capabilities.limitations.length, 3);
  assert.deepEqual(
    capabilities.tools.map(
      (tool) => tool.type === "function" && tool.function.name,
    ),
    ["mcp_1_working-server_0_inspect"],
  );
  assert.deepEqual(
    JSON.parse(await capabilities.call("mcp_1_working-server_0_inspect", {})),
    { observed: true },
  );
  for (const name of [
    "cbm_partial-graph-tool",
    "mcp_0_private-name_0_a-partial",
    "memory_read",
  ])
    await assert.rejects(capabilities.call(name, {}), /disabled/);
  assert.doesNotMatch(
    JSON.stringify(capabilities.limitations) + observedLogs.join(""),
    /private-|fixture-token/,
  );
  await capabilities.close();
  assert.equal(graphClosed, 1);
  assert.equal(closed, 2);
});

test("cancellation during optional startup closes the client and remains fatal", async (t) => {
  const abort = new AbortController();
  let closed = 0;
  t.mock.method(RemoteMemory.prototype, "start", async () => {
    abort.abort(new Error("cancelled startup"));
    throw new Error("upstream failure");
  });
  t.mock.method(RemoteMemory.prototype, "close", async () => {
    closed++;
  });
  const capabilities = new ReviewCapabilities(
    optionalCapabilities(),
    log,
    abort.signal,
  );
  await assert.rejects(
    capabilities.start(),
    (error) => error === abort.signal.reason,
  );
  assert.ok(closed >= 1);
  assert.deepEqual(capabilities.limitations, []);
  assert.deepEqual(capabilities.tools, []);
});

test("approved instruction and skill failures remain fatal before optional startup", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "razbor-required-guidance-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  t.mock.method(RemoteMemory.prototype, "start", async () => {
    starts++;
  });
  const configs = [
    {
      ...optionalCapabilities(),
      instructions: [
        { path: path.join(root, "missing.md"), provenance: "approved" },
      ],
    },
    { ...optionalCapabilities(), skills: [path.join(root, "missing-skills")] },
  ];
  for (const config of configs) {
    const capabilities = new ReviewCapabilities(
      config,
      log,
      new AbortController().signal,
    );
    await assert.rejects(capabilities.start());
    assert.deepEqual(capabilities.limitations, []);
  }
  assert.equal(starts, 0);
});

test("bounded files reject symlinks/oversize and outputs declare truncation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-text-"));
  try {
    await writeFile(path.join(root, "instructions.md"), "x".repeat(300));
    await assert.rejects(boundedText(path.join(root, "instructions.md"), 256));
    await symlink(
      path.join(root, "instructions.md"),
      path.join(root, "link.md"),
    );
    await assert.rejects(boundedText(path.join(root, "link.md"), 500));
    const text = boundedOutput("a".repeat(1000), 256);
    assert.ok(Buffer.byteLength(text) <= 256);
    assert.match(text, /TRUNCATED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional startup and final cleanup failures stay sanitized, nonfatal and idempotent", async (t) => {
  let closes = 0;
  const config = optionalCapabilities();
  delete config.mcpServers;
  delete config.memory;
  t.mock.method(RemoteMemory.prototype, "start", async () => {
    throw new Error("private startup token");
  });
  t.mock.method(RemoteMemory.prototype, "close", async () => {
    closes++;
    throw new Error("private cleanup token");
  });
  const capabilities = new ReviewCapabilities(
    config,
    log,
    new AbortController().signal,
  );
  await capabilities.start();
  await capabilities.close();
  await capabilities.close();
  assert.equal(closes, 1);
  assert.equal(
    capabilities.limitations.filter((value) => /cleanup/.test(value)).length,
    1,
  );
  assert.match(capabilities.limitations.join(" "), /unavailable/);
  assert.doesNotMatch(capabilities.limitations.join(" "), /private|token/);
  await assert.rejects(capabilities.call("cbm_search_graph", {}), /disabled/);
});

test("optional final cleanup failure cannot replace a successful startup or swallow cancellation", async (t) => {
  const config = optionalCapabilities();
  delete config.mcpServers;
  delete config.memory;
  let closes = 0;
  t.mock.method(RemoteMemory.prototype, "start", async () => {});
  t.mock.method(RemoteMemory.prototype, "close", async () => {
    closes++;
    throw new Error("private cleanup token");
  });
  const abort = new AbortController();
  const capabilities = new ReviewCapabilities(config, log, abort.signal);
  await capabilities.start();
  await capabilities.close();
  await capabilities.close();
  assert.equal(closes, 1);
  assert.equal(capabilities.limitations.length, 1);
  abort.abort(new Error("review cancelled"));
  await assert.rejects(
    capabilities.close(),
    (error) => error === abort.signal.reason,
  );
});
