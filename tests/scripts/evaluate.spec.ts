import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/evaluate.ts", import.meta.url),
);

const datasetPath = fileURLToPath(
  new URL("../evaluation/audited-revisions.json", import.meta.url),
);

/** Binds a result or dataset to its original bytes in the offline run format. */
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Creates a historical execution without fields introduced by the autonomous loop. */
function execution(sample: {
  repository: string;
  baseSha: string;
  headSha: string;
}) {
  return {
    runId: "historical-run",
    repository: sample.repository,
    baseSha: sample.baseSha,
    headSha: sample.headSha,
    configuration: {
      label: "comparison",
      model: "fixture-model",
      promptVersion: null,
      capabilitiesVersion: null,
      maxTurns: 24,
    },
    status: "completed",
    result: {
      summary: "No finding in this deterministic fixture",
      findings: [],
    },
    telemetry: {
      durationMs: 100,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      tokenUsageComplete: true,
      costUsd: 0.01,
      costBasis: "estimate",
    },
    failureCategory: null,
  };
}

/** Invokes only the offline CLI; these tests never submit reviews or call models. */
function evaluate(...args: string[]) {
  return spawnSync(process.execPath, ["--import=tsx", script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2_000_000,
  });
}

test("offline evaluation preserves historical records and marks missing new measurements unknown", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-evaluate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
  const original = execution(dataset.cases[0]);
  const input = path.join(root, "execution.json");
  await writeFile(input, JSON.stringify(original));
  const prepared = evaluate("record", datasetPath, dataset.cases[0].id, input);
  assert.equal(prepared.status, 0, prepared.stderr);
  const run = JSON.parse(prepared.stdout);
  assert.deepEqual(run.execution, original);
  const filename = path.join(root, "run.json");
  await writeFile(filename, prepared.stdout);
  const scored = evaluate("score", datasetPath, filename);
  assert.equal(scored.status, 0, scored.stderr);
  const group = JSON.parse(scored.stdout).configurations[0];
  for (const key of [
    "modelTurns",
    "toolCalls",
    "uncachedInputTokens",
    "cacheWriteTokens",
    "budgetTokens",
  ])
    assert.deepEqual(group[key], {
      total: null,
      measuredRuns: 0,
      missingRuns: 1,
    });
  assert.equal(group.inputTokens.total, 100);
  assert.equal(group.cases[0].telemetry.inputTokens, 100);
});

test("offline scores include failed-attempt turns, tools, cache writes and conservative charges", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-evaluate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = await readFile(datasetPath, "utf8");
  const dataset = JSON.parse(raw);
  const original = execution(dataset.cases[0]);
  const failed = {
    ...original,
    runId: "budget-failure",
    status: "failed",
    result: null,
    failureCategory: "budget_exhausted",
    telemetry: {
      durationMs: 200,
      inputTokens: 50,
      cachedInputTokens: 10,
      uncachedInputTokens: 30,
      cacheWriteTokens: 10,
      outputTokens: 5,
      modelTurns: 2,
      toolCalls: 3,
      budgetTokens: 150,
      tokenUsageComplete: false,
      costUsd: 0.2,
      costBasis: "estimate",
      costEstimateComplete: false,
    },
  };
  const files: string[] = [];
  for (const item of [original, failed]) {
    const filename = path.join(root, item.runId + ".json");
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        datasetSha256: hash(raw),
        caseId: dataset.cases[0].id,
        assessor: null,
        resultSha256: hash(JSON.stringify(item.result)),
        execution: item,
        judgments: [],
      }),
    );
    files.push(filename);
  }
  const scored = evaluate("score", datasetPath, ...files);
  assert.equal(scored.status, 0, scored.stderr);
  const group = JSON.parse(scored.stdout).configurations[0];
  assert.equal(group.attempts, 2);
  assert.equal(group.failed, 1);
  assert.equal(group.failureRate, 0.5);
  assert.deepEqual(group.modelTurns, {
    total: 2,
    measuredRuns: 1,
    missingRuns: 1,
  });
  assert.deepEqual(group.toolCalls, {
    total: 3,
    measuredRuns: 1,
    missingRuns: 1,
  });
  assert.deepEqual(group.cacheWriteTokens, {
    total: 10,
    measuredRuns: 1,
    missingRuns: 1,
  });
  assert.equal(group.uncachedInputTokens.total, 30);
  assert.equal(group.inputTokens.total, 150);
  assert.equal(group.budgetTokens.total, 150);
  assert.equal(group.usageCompleteRuns, 1);
  assert.equal(group.costEstimateCompleteRuns, 0);
  assert.equal(group.latencyMs.median, 100);
  assert.equal(group.latencyMs.p95, 200);
  assert.equal(group.cases[1].telemetry.costEstimateComplete, false);
});

test("offline evaluation rejects impossible measured cache splits without echoing input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-evaluate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
  for (const split of [
    { uncachedInputTokens: 90, cacheWriteTokens: 10 },
    { uncachedInputTokens: 30, cacheWriteTokens: 10 },
    { uncachedInputTokens: null, cacheWriteTokens: 90 },
  ]) {
    const original = execution(dataset.cases[0]);
    const filename = path.join(root, "invalid.json");
    await writeFile(
      filename,
      JSON.stringify({
        ...original,
        result: { summary: "private-source-marker", findings: [] },
        telemetry: { ...original.telemetry, ...split },
      }),
    );
    const prepared = evaluate(
      "record",
      datasetPath,
      dataset.cases[0].id,
      filename,
    );
    assert.equal(prepared.status, 1);
    assert.match(prepared.stderr, /Invalid evaluation input/);
    assert.doesNotMatch(prepared.stderr, /private-source-marker/);
  }
});

test("new review limits remain distinct configuration provenance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-evaluate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = await readFile(datasetPath, "utf8");
  const dataset = JSON.parse(raw);
  const original = execution(dataset.cases[0]);
  const files: string[] = [];
  for (const maxToolCalls of [20, 30]) {
    const item = {
      ...original,
      runId: "limit-" + maxToolCalls,
      configuration: {
        ...original.configuration,
        maxToolCalls,
        maxTokens: 100_000,
        compactionThresholdTokens: 80_000,
      },
    };
    const filename = path.join(root, item.runId + ".json");
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        datasetSha256: hash(raw),
        caseId: dataset.cases[0].id,
        assessor: null,
        resultSha256: hash(JSON.stringify(item.result)),
        execution: item,
        judgments: [],
      }),
    );
    files.push(filename);
  }
  const scored = evaluate("score", datasetPath, ...files);
  assert.equal(scored.status, 0, scored.stderr);
  assert.equal(JSON.parse(scored.stdout).configurations.length, 2);
});
