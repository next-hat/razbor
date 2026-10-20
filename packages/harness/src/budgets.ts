import {
  reviewBudgetSchema,
  reviewMaxTurnsSchema,
  type ReviewAttemptMetrics,
  type ReviewBudgetOptions as ConfiguredReviewBudget,
} from "@razbor/contracts";

import type { ModelTurn } from "@harness/src/model.js";

export type ReviewBudgetOptions = ConfiguredReviewBudget;

type Reservation = {
  input: number;
  output: number;
  tokens: number;
  cost?: number;
};

export class ReviewBudgetExceeded extends Error {
  /** Exposes a safe, deterministic reason without retaining prompts or provider data. */
  constructor(limit: string) {
    super(`Review budget exhausted: ${limit}`);
    this.name = "ReviewBudgetExceeded";
  }
}

/** Accepts only real provider counts; absent, fractional or invalid values remain unknown. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Accounts for one review, reserving a full capped response before every paid call. */
export class ReviewBudget {
  readonly options: ReturnType<typeof reviewBudgetSchema.parse>;
  readonly maxTurns: number;
  private reservation?: Reservation;
  private turns = 0;
  private calls = 0;
  private tokens = 0;
  private cost = 0;
  private complete = true;
  private costComplete = true;
  private measured: ModelTurn["usage"] = {};
  private missing = new Set<keyof ModelTurn["usage"]>();

  /** Rejects unpriced monetary limits and pricing that does not match the selected model. */
  constructor(
    options: ReviewBudgetOptions & { maxTurns?: number; model?: string } = {},
  ) {
    const { maxTurns, model, ...limits } = options;
    this.options = reviewBudgetSchema.parse(limits);
    this.maxTurns = reviewMaxTurnsSchema.parse(maxTurns);
    if (this.options.pricing && this.options.pricing.model !== model)
      throw new Error("Review pricing must match the selected model exactly");
  }

  /** Reserves conservatively before dispatch; rejected calls consume no provider request. */
  beginModelTurn(inputEstimate: number): void {
    if (this.reservation) throw new Error("A model turn is already active");
    if (!Number.isSafeInteger(inputEstimate) || inputEstimate < 0)
      throw new Error("Invalid model input estimate");
    if (this.turns >= this.maxTurns)
      throw new ReviewBudgetExceeded("model turns");
    const output = this.options.maxOutputTokens;
    const tokens = inputEstimate + output;
    const pricing = this.options.pricing;
    const cost = pricing
      ? (inputEstimate *
          Math.max(
            pricing.inputUsdPerMillion,
            pricing.cachedInputUsdPerMillion,
            pricing.cacheWriteUsdPerMillion,
          ) +
          output * pricing.outputUsdPerMillion) /
        1000000
      : undefined;
    if (this.tokens + tokens > this.options.maxTokens)
      throw new ReviewBudgetExceeded("tokens");
    if (
      cost !== undefined &&
      this.options.maxCostUsd !== undefined &&
      this.cost + cost > this.options.maxCostUsd
    )
      throw new ReviewBudgetExceeded("estimated monetary cost");
    this.reservation = { input: inputEstimate, output, tokens, cost };
    this.turns++;
  }

  /** Settles trustworthy measurements, retaining the reservation when telemetry is incomplete. */
  observeModelTurn(turn: Pick<ModelTurn, "usage" | "usageComplete">): void {
    const reservation = this.reservation;
    if (!reservation) throw new Error("No active model turn");
    this.reservation = undefined;
    const usage = Object.fromEntries(
      Object.entries(turn.usage).map(([key, value]) => [key, count(value)]),
    ) as ModelTurn["usage"];
    if (
      usage.inputTokens !== undefined &&
      ((usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) >
        usage.inputTokens ||
        (usage.uncachedInputTokens !== undefined &&
          usage.cachedInputTokens !== undefined &&
          usage.cacheWriteTokens !== undefined &&
          usage.uncachedInputTokens +
            usage.cachedInputTokens +
            usage.cacheWriteTokens !==
            usage.inputTokens))
    ) {
      delete usage.uncachedInputTokens;
      delete usage.cachedInputTokens;
      delete usage.cacheWriteTokens;
    }
    if (turn.usageComplete === false)
      for (const key of [
        "cachedInputTokens",
        "uncachedInputTokens",
        "cacheWriteTokens",
      ] as const)
        this.missing.add(key);
    const measuredComplete =
      turn.usageComplete !== false &&
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined;
    this.complete &&= measuredComplete;
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "uncachedInputTokens",
      "cacheWriteTokens",
    ] as const) {
      const value = usage[key];
      if (value === undefined) this.missing.add(key);
      else this.measured[key] = (this.measured[key] ?? 0) + value;
    }
    const measuredTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.tokens += measuredComplete
      ? measuredTokens
      : Math.max(reservation.tokens, measuredTokens);
    const pricing = this.options.pricing;
    if (pricing) {
      const pricedComplete =
        measuredComplete &&
        usage.uncachedInputTokens !== undefined &&
        usage.cachedInputTokens !== undefined &&
        usage.cacheWriteTokens !== undefined;
      const measuredCost =
        ((usage.uncachedInputTokens ?? 0) * pricing.inputUsdPerMillion +
          (usage.cachedInputTokens ?? 0) * pricing.cachedInputUsdPerMillion +
          (usage.cacheWriteTokens ?? 0) * pricing.cacheWriteUsdPerMillion +
          (usage.outputTokens ?? 0) * pricing.outputUsdPerMillion) /
        1000000;
      this.cost += pricedComplete
        ? measuredCost
        : Math.max(reservation.cost ?? 0, measuredCost);
      this.costComplete &&= pricedComplete;
    }
    this.assertWithinLimits();
  }

  /** A failed or cancelled dispatch may still be billed, so its full reservation survives. */
  failModelTurn(): void {
    if (!this.reservation) return;
    this.tokens += this.reservation.tokens;
    this.cost += this.reservation.cost ?? 0;
    this.reservation = undefined;
    this.complete = false;
    this.costComplete = false;
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "uncachedInputTokens",
      "cacheWriteTokens",
    ] as const)
      this.missing.add(key);
  }

  /** Rejects a whole tool batch before execution when it would cross the review limit. */
  useToolCalls(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error("Invalid tool-call count");
    if (this.calls + amount > this.options.maxToolCalls)
      throw new ReviewBudgetExceeded("tool calls");
    this.calls += amount;
  }

  /** Returns cumulative measurements plus conservative budget charges for durable attempt metrics. */
  metrics(): ReviewAttemptMetrics {
    const snapshot: ReviewAttemptMetrics = {
      ...this.measured,
      modelTurns: this.turns,
      toolCalls: this.calls,
      budgetTokens: this.tokens,
      tokenUsageComplete: this.complete,
      ...(this.options.pricing
        ? {
            estimatedCostUsd: this.cost,
            costEstimateComplete: this.costComplete,
          }
        : {}),
    };
    // Cache ratios and uncached counts cannot be inferred when any call omitted the split.
    for (const key of [
      "cachedInputTokens",
      "uncachedInputTokens",
      "cacheWriteTokens",
    ] as const)
      if (this.missing.has(key)) delete snapshot[key];
    return snapshot;
  }

  /** Fails immediately if a provider's actual usage exceeds the conservative reservation. */
  private assertWithinLimits(): void {
    if (this.tokens > this.options.maxTokens)
      throw new ReviewBudgetExceeded("tokens");
    if (
      this.options.maxCostUsd !== undefined &&
      this.cost > this.options.maxCostUsd
    )
      throw new ReviewBudgetExceeded("estimated monetary cost");
  }
}
