import assert from "node:assert/strict";
import { test } from "node:test";

import { AttemptProgress } from "@razbor/runner/progress";

test("throttled progress carries a coherent cumulative snapshot after 500 events", () => {
  const progress = new AttemptProgress();
  const base = {
    time: "2026-10-20T10:00:00Z",
    level: "info" as const,
    stage: "model" as const,
    message: "progress",
  };
  progress.capture({
    ...base,
    source: "agent",
    model: "fixture",
    turn: 2,
    maxTurns: 10,
    modelTurns: 2,
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 30,
    uncachedInputTokens: 70,
    toolCalls: 4,
    estimatedCostUsd: 0.001,
    costEstimateComplete: true,
  });
  for (let count = 1; count < 500; count++) progress.capture(base);
  const payload = progress.capture({
    ...base,
    modelTurns: 3,
    inputTokens: 250,
    outputTokens: 25,
    cachedInputTokens: 80,
    uncachedInputTokens: 170,
    estimatedCostUsd: 0.0025,
  });
  assert.equal(payload?.turn, 3);
  assert.equal(payload?.maxTurns, 10);
  assert.equal(payload?.model, "fixture");
  assert.equal(payload?.toolCalls, 4);
  assert.equal(payload?.costEstimateComplete, true);
  assert.equal(payload?.inputTokens, 250);
  assert.equal(payload?.cachedInputTokens, 80);
  assert.equal(payload?.estimatedCostUsd, 0.0025);
  assert.equal(progress.capture(base), undefined);
  const incomplete = progress.capture({ ...base, tokenUsageComplete: false });
  assert.equal(incomplete?.inputTokens, 250);
  assert.equal(incomplete?.cachedInputTokens, undefined);
  assert.equal(incomplete?.costEstimateComplete, false);
  assert.equal(incomplete?.estimatedCostUsd, 0.0025);
});

test("full progress events cannot revive unverified cache categories after a usage gap", () => {
  const progress = new AttemptProgress();
  const base = {
    time: "2026-10-20T10:00:00Z",
    level: "info" as const,
    stage: "model" as const,
    message: "progress",
  };
  progress.capture({ ...base, inputTokens: 100, tokenUsageComplete: false });
  const payload = progress.capture({
    ...base,
    inputTokens: 200,
    cachedInputTokens: 50,
    uncachedInputTokens: 150,
    cacheWriteTokens: 0,
    tokenUsageComplete: true,
    estimatedCostUsd: 0.01,
    costEstimateComplete: true,
  });
  assert.equal(payload?.tokenUsageComplete, false);
  assert.equal(payload?.cachedInputTokens, undefined);
  assert.equal(payload?.uncachedInputTokens, undefined);
  assert.equal(payload?.cacheWriteTokens, undefined);
  assert.equal(payload?.costEstimateComplete, false);
});
