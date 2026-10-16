import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Tool } from "@modelcontextprotocol/client";
import pino from "pino";

import { capabilityLimitsSchema, reviewResultSchema } from "@razbor/contracts";
import { SkillCatalog } from "@razbor/harness/skills";
import { BoundTools, readOnlyTools, resultText } from "@razbor/harness/mcp";
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
