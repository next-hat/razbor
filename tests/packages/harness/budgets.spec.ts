import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reviewAttemptMetricsSchema,
  reviewBudgetSchema,
} from "@razbor/contracts";
import { ReviewBudget, ReviewBudgetExceeded } from "@razbor/harness/budget";
import { measuredUsage } from "@razbor/harness/model";
import { runnerConfigSchema } from "@razbor/runner/config";

const pricing = {
  model: "fixture",
  inputUsdPerMillion: 2,
  cachedInputUsdPerMillion: 0.2,
  outputUsdPerMillion: 8,
  cacheWriteUsdPerMillion: 2.5,
};

const usage = {
  inputTokens: 100,
  uncachedInputTokens: 40,
  cachedInputTokens: 50,
  cacheWriteTokens: 10,
  outputTokens: 20,
};

test("measured token categories settle a model reservation with explicit prices", () => {
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxTurns: 2,
    maxOutputTokens: 100,
    maxTokens: 1000,
    maxCostUsd: 1,
  });
  budget.beginModelTurn(200);
  budget.observeModelTurn({ usage });
  budget.useToolCalls(2);
  const metrics = reviewAttemptMetricsSchema.parse(budget.metrics());
  assert.deepEqual(metrics, {
    ...usage,
    modelTurns: 1,
    toolCalls: 2,
    budgetTokens: 120,
    tokenUsageComplete: true,
    estimatedCostUsd: 0.000275,
    costEstimateComplete: true,
  });
});

test("all review limits reject before an extra model request or tool batch", () => {
  const turns = new ReviewBudget({ maxTurns: 1, maxOutputTokens: 10 });
  turns.beginModelTurn(100);
  turns.observeModelTurn({ usage });
  assert.throws(() => turns.beginModelTurn(100), /model turns/);
  assert.equal(turns.metrics().modelTurns, 1);
  const tools = new ReviewBudget({ maxToolCalls: 1 });
  assert.throws(() => tools.useToolCalls(2), /tool calls/);
  assert.equal(tools.metrics().toolCalls, 0);
  const tokens = new ReviewBudget({ maxTokens: 100, maxOutputTokens: 10 });
  assert.throws(() => tokens.beginModelTurn(91), /tokens/);
  assert.equal(tokens.metrics().modelTurns, 0);
  const money = new ReviewBudget({
    model: "fixture",
    pricing,
    maxCostUsd: 0.000001,
    maxOutputTokens: 10,
  });
  assert.throws(() => money.beginModelTurn(1), /monetary/);
  assert.equal(money.metrics().modelTurns, 0);
});

test("failed calls retain conservative charges and already observed successful usage", () => {
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxOutputTokens: 100,
  });
  budget.beginModelTurn(200);
  budget.observeModelTurn({ usage });
  budget.beginModelTurn(300);
  budget.failModelTurn();
  const metrics = budget.metrics();
  assert.equal(metrics.modelTurns, 2);
  assert.equal(metrics.budgetTokens, 520);
  assert.equal(metrics.inputTokens, 100);
  assert.equal(metrics.outputTokens, 20);
  assert.equal(metrics.tokenUsageComplete, false);
  assert.equal(metrics.costEstimateComplete, false);
  assert.ok((metrics.estimatedCostUsd ?? 0) > 0.0018);
  assert.equal(metrics.cachedInputTokens, undefined);
});

test("missing telemetry cannot release a reservation or fabricate measured usage", () => {
  const budget = new ReviewBudget({ maxTokens: 1000, maxOutputTokens: 100 });
  budget.beginModelTurn(300);
  budget.observeModelTurn({ usage: { inputTokens: 10 } });
  assert.equal(budget.metrics().budgetTokens, 400);
  assert.equal(budget.metrics().outputTokens, undefined);
  assert.equal(budget.metrics().tokenUsageComplete, false);
  assert.throws(() => budget.beginModelTurn(501), ReviewBudgetExceeded);
});

test("actual provider overruns halt immediately while preserving final metrics", () => {
  const budget = new ReviewBudget({ maxTokens: 50, maxOutputTokens: 10 });
  budget.beginModelTurn(10);
  assert.throws(() => budget.observeModelTurn({ usage }), /tokens/);
  assert.equal(budget.metrics().budgetTokens, 120);
  assert.equal(budget.metrics().outputTokens, 20);
});

test("pricing is explicit and bound to the selected model", () => {
  assert.equal(reviewBudgetSchema.safeParse({ maxCostUsd: 1 }).success, false);
  assert.throws(() => new ReviewBudget({ model: "other", pricing }), /match/);
  assert.equal(new ReviewBudget().metrics().estimatedCostUsd, undefined);
  assert.equal(runnerConfigSchema.parse({}).model.max_retries, 0);
  assert.equal(
    runnerConfigSchema.parse({}).harness.compactionThresholdTokens,
    80000,
  );
});

test("native provider measurements distinguish cache reads and writes without inferred zeros", () => {
  assert.deepEqual(
    measuredUsage("anthropic", {
      inputTokens: 100,
      outputTokens: 20,
      raw: {
        raw: {
          input_tokens: 40,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      },
    }),
    usage,
  );
  assert.deepEqual(
    measuredUsage("openai", {
      inputTokens: 100,
      outputTokens: 20,
      raw: { raw: { input_tokens_details: { cached_tokens: 50 } } },
    }),
    {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      uncachedInputTokens: 50,
      cacheWriteTokens: 0,
    },
  );
  const missing = measuredUsage("anthropic", {
    inputTokens: 100,
    outputTokens: 20,
  });
  assert.equal(missing.cachedInputTokens, undefined);
  assert.equal(missing.cacheWriteTokens, undefined);
  assert.equal(missing.uncachedInputTokens, undefined);
});

test("inconsistent provider splits cannot produce a precise monetary estimate", () => {
  const invalid = measuredUsage("openai", {
    inputTokens: 10,
    outputTokens: 2,
    raw: { raw: { input_tokens_details: { cached_tokens: 50 } } },
  });
  assert.equal(invalid.cachedInputTokens, undefined);
  assert.equal(invalid.uncachedInputTokens, undefined);
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxOutputTokens: 100,
  });
  budget.beginModelTurn(200);
  budget.observeModelTurn({ usage: { ...usage, cachedInputTokens: 500 } });
  assert.equal(budget.metrics().costEstimateComplete, false);
  assert.equal(budget.metrics().cachedInputTokens, undefined);
  assert.equal(budget.metrics().estimatedCostUsd, 0.0013);
});
