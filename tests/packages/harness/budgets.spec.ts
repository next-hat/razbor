import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentJobSchema,
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

for (const partial of [
  { name: "input", usage: { inputTokens: 250 } },
  { name: "output", usage: { outputTokens: 250 } },
  { name: "input categories", usage: { cachedInputTokens: 250 } },
]) {
  test(`incomplete ${partial.name} usage retains the independently missing token reservation`, () => {
    const budget = new ReviewBudget({ maxTokens: 400, maxOutputTokens: 100 });
    budget.beginModelTurn(100);
    budget.observeModelTurn({ usage: partial.usage });
    const metrics = budget.metrics();
    assert.equal(metrics.budgetTokens, 350);
    assert.equal(metrics.inputTokens, partial.usage.inputTokens);
    assert.equal(metrics.outputTokens, partial.usage.outputTokens);
    assert.equal(metrics.tokenUsageComplete, false);
    assert.equal(budget.remaining().tokens, 50);
    assert.equal(budget.canReserveModelTurns(0), false);
    assert.throws(() => budget.beginModelTurn(0), /tokens/);
    assert.equal(budget.metrics().modelTurns, 1);
  });
}

test("measured zero input or output counts release that category's reservation", () => {
  for (const measured of [
    { inputTokens: 250, outputTokens: 0 },
    { inputTokens: 0, outputTokens: 250 },
    { inputTokens: 0, outputTokens: 0 },
  ]) {
    const budget = new ReviewBudget({ maxTokens: 400, maxOutputTokens: 100 });
    budget.beginModelTurn(100);
    budget.observeModelTurn({ usage: measured });
    assert.equal(
      budget.metrics().budgetTokens,
      measured.inputTokens + measured.outputTokens,
    );
    assert.equal(budget.metrics().inputTokens, measured.inputTokens);
    assert.equal(budget.metrics().outputTokens, measured.outputTokens);
    assert.equal(budget.metrics().tokenUsageComplete, true);
  }
});

test("zero output remains measured when input telemetry is incomplete", () => {
  const budget = new ReviewBudget({ maxTokens: 400, maxOutputTokens: 100 });
  budget.beginModelTurn(100);
  budget.observeModelTurn({
    usage: { cachedInputTokens: 250, outputTokens: 0 },
  });
  assert.equal(budget.metrics().budgetTokens, 250);
  assert.equal(budget.metrics().inputTokens, undefined);
  assert.equal(budget.metrics().outputTokens, 0);
  assert.equal(budget.metrics().tokenUsageComplete, false);
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
  assert.doesNotThrow(() => new ReviewBudget({ model: "other", pricing }));
  assert.throws(
    () => new ReviewBudget({ model: "other", pricing, maxCostUsd: 1 }),
    /match/,
  );
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

test("partial usage charges measured input beyond the reservation at the highest unknown-category rate", () => {
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxOutputTokens: 10,
    maxCostUsd: 0.01,
  });
  budget.beginModelTurn(1);
  assert.throws(
    () =>
      budget.observeModelTurn({
        usage: { inputTokens: 100000, outputTokens: 1 },
      }),
    /monetary/,
  );
  assert.equal(budget.metrics().estimatedCostUsd, 0.250008);
  assert.equal(budget.metrics().costEstimateComplete, false);
});

test("partial known categories charge every remaining measured token at the highest rate", () => {
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxOutputTokens: 10,
  });
  budget.beginModelTurn(1);
  budget.observeModelTurn({
    usage: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 2 },
  });
  assert.equal(budget.metrics().estimatedCostUsd, 0.002286);
  assert.equal(budget.metrics().costEstimateComplete, false);
});

test("per-model pricing selects the assigned provider and model without blocking unpriced uncapped reviews", () => {
  const entries = [
    { ...pricing, provider: "openai" as const },
    {
      ...pricing,
      provider: "anthropic" as const,
      model: "claude-fixture",
      inputUsdPerMillion: 20,
      cachedInputUsdPerMillion: 2,
      cacheWriteUsdPerMillion: 25,
      outputUsdPerMillion: 80,
    },
  ];
  assert.equal(
    reviewBudgetSchema.safeParse({ pricing: entries }).success,
    true,
  );
  const claude = new ReviewBudget({
    model: "claude-fixture",
    provider: "anthropic",
    pricing: entries,
    maxOutputTokens: 100,
    maxCostUsd: 1,
  });
  claude.beginModelTurn(100);
  claude.observeModelTurn({ usage });
  assert.equal(claude.metrics().estimatedCostUsd, 0.00275);
  assert.doesNotThrow(
    () =>
      new ReviewBudget({
        model: "unpriced",
        provider: "anthropic",
        pricing: entries,
      }),
  );
  assert.throws(
    () =>
      new ReviewBudget({
        model: "unpriced",
        provider: "anthropic",
        pricing: entries,
        maxCostUsd: 1,
      }),
    /match/,
  );
  assert.throws(
    () =>
      new ReviewBudget({
        model: "fixture",
        provider: "anthropic",
        pricing,
        maxCostUsd: 1,
      }),
    /match/,
  );
});

test("budget headroom forecasts model calls without mutation at exact boundaries", () => {
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxTurns: 3,
    maxToolCalls: 2,
    maxTokens: 300,
    maxOutputTokens: 10,
    maxCostUsd: 1,
  });
  assert.deepEqual(budget.remaining(), {
    modelTurns: 3,
    toolCalls: 2,
    tokens: 300,
    costUsd: 1,
  });
  assert.equal(budget.canReserveModelTurns(90, 3), true);
  assert.equal(budget.canReserveModelTurns(91, 3), false);
  assert.equal(budget.canReserveModelTurns(1, 4), false);
  assert.equal(budget.metrics().modelTurns, 0);
  budget.beginModelTurn(90);
  assert.equal(budget.remaining().tokens, 200);
  budget.observeModelTurn({
    usage: {
      inputTokens: 90,
      uncachedInputTokens: 90,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
    },
  });
  budget.useToolCalls(2);
  assert.equal(budget.remaining().modelTurns, 2);
  assert.equal(budget.remaining().tokens, 200);
  assert.equal(budget.remaining().toolCalls, 0);
  assert.equal(budget.canReserveModelTurns(90, 2), true);
  assert.equal(budget.canReserveModelTurns(90, 3), false);
});

test("monetary headroom uses the same worst-case rates as dispatch admission", () => {
  const budget = new ReviewBudget({
    model: "fixture",
    pricing,
    maxTurns: 3,
    maxOutputTokens: 10,
    maxCostUsd: 0.00066,
  });
  assert.equal(budget.canReserveModelTurns(100, 2), true);
  assert.equal(budget.canReserveModelTurns(101, 2), false);
  assert.equal(budget.remaining().costUsd, 0.00066);
});

test("runner configuration preserves all prices until the assigned agent identity is known", () => {
  const prices = [
    { ...pricing, provider: "openai" },
    { ...pricing, provider: "anthropic", model: "claude-fixture" },
  ];
  const config = runnerConfigSchema.parse({
    harness: { contextWindowTokens: 64000, reviewBudget: { pricing: prices } },
  });
  const job = agentJobSchema.parse({
    version: 1,
    reviewId: "rev_0123456789ABCDEF",
    repository: "/tmp/review",
    base: "a".repeat(40),
    head: "b".repeat(40),
    reviewBudget: config.harness.reviewBudget,
    contextWindowTokens: config.harness.contextWindowTokens,
  });
  assert.deepEqual(job.reviewBudget?.pricing, prices);
  assert.equal(job.contextWindowTokens, 64000);
  assert.equal(
    runnerConfigSchema.parse({}).harness.contextWindowTokens,
    undefined,
  );
  assert.equal(
    agentJobSchema.parse({
      version: 1,
      reviewId: "rev_0123456789ABCDEF",
      repository: "/tmp/review",
      base: "a".repeat(40),
      head: "b".repeat(40),
    }).contextWindowTokens,
    undefined,
  );
  assert.equal(
    runnerConfigSchema.safeParse({ harness: { contextWindowTokens: 1023 } })
      .success,
    false,
  );
  assert.equal(
    runnerConfigSchema.safeParse({ harness: { contextWindowTokens: 10000001 } })
      .success,
    false,
  );
});

test("duplicate provider/model price entries are rejected instead of selecting arbitrary rates", () => {
  assert.equal(
    reviewBudgetSchema.safeParse({
      pricing: [pricing, { ...pricing, inputUsdPerMillion: 99 }],
    }).success,
    false,
  );
  const unpriced = new ReviewBudget({
    provider: "anthropic",
    model: "fixture",
    pricing,
  });
  unpriced.beginModelTurn(10);
  unpriced.observeModelTurn({ usage });
  assert.equal(unpriced.metrics().estimatedCostUsd, undefined);
  assert.equal(unpriced.metrics().budgetTokens, 120);
});

test("known input categories still consume the token budget when the provider omits its input total", () => {
  const budget = new ReviewBudget({ maxTokens: 1000, maxOutputTokens: 10 });
  budget.beginModelTurn(1);
  assert.throws(
    () =>
      budget.observeModelTurn({
        usage: { cachedInputTokens: 100000, outputTokens: 1 },
      }),
    /tokens/,
  );
  assert.equal(budget.metrics().budgetTokens, 100001);
  assert.equal(budget.metrics().tokenUsageComplete, false);
});
