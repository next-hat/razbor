import {
  reviewBudgetSchema,
  reviewMaxTurnsSchema,
  type ModelProvider,
  type ReviewPricing,
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
  readonly pricing?: ReviewPricing;
  private reservation?: Reservation;
  private turns = 0;
  private calls = 0;
  private tokens = 0;
  private cost = 0;
  private complete = true;
  private costComplete = true;
  private measured: ModelTurn["usage"] = {};
  private missing = new Set<keyof ModelTurn["usage"]>();

  /** Selects exact provider/model prices; only monetary caps require a matching entry. */
  constructor(
    options: ReviewBudgetOptions & {
      maxTurns?: number;
      model?: string;
      provider?: ModelProvider;
    } = {},
  ) {
    const { maxTurns, model, provider = "openai", ...limits } = options;
    this.options = reviewBudgetSchema.parse(limits);
    this.maxTurns = reviewMaxTurnsSchema.parse(maxTurns);
    const entries = Array.isArray(this.options.pricing)
      ? this.options.pricing
      : this.options.pricing
        ? [this.options.pricing]
        : [];
    this.pricing = entries.find(
      (entry) => entry.model === model && entry.provider === provider,
    );
    if (this.options.maxCostUsd !== undefined && !this.pricing)
      throw new Error(
        "Review pricing must match the selected provider and model exactly",
      );
  }

  /** Reports remaining hard limits, including any currently active model reservation. */
  remaining(): {
    modelTurns: number;
    toolCalls: number;
    tokens: number;
    costUsd?: number;
  } {
    return {
      modelTurns: Math.max(0, this.maxTurns - this.turns),
      toolCalls: Math.max(0, this.options.maxToolCalls - this.calls),
      tokens: Math.max(
        0,
        this.options.maxTokens - this.tokens - (this.reservation?.tokens ?? 0),
      ),
      ...(this.options.maxCostUsd !== undefined
        ? {
            costUsd: Math.max(
              0,
              this.options.maxCostUsd -
                this.cost -
                (this.reservation?.cost ?? 0),
            ),
          }
        : {}),
    };
  }

  /** Forecasts capped calls using dispatch admission's reservation without spending budget. */
  canReserveModelTurns(inputEstimate: number, turns = 1): boolean {
    if (!Number.isSafeInteger(turns) || turns < 0)
      throw new Error("Invalid model-turn count");
    const reservation = this.modelReservation(inputEstimate);
    const remaining = this.remaining();
    return (
      turns <= remaining.modelTurns &&
      reservation.tokens * turns <= remaining.tokens &&
      (remaining.costUsd === undefined ||
        (reservation.cost ?? 0) * turns <= remaining.costUsd)
    );
  }

  /** Reserves conservatively before dispatch; rejected calls consume no provider request. */
  beginModelTurn(inputEstimate: number): void {
    if (this.reservation) throw new Error("A model turn is already active");
    if (this.turns >= this.maxTurns)
      throw new ReviewBudgetExceeded("model turns");
    const { output, tokens, cost } = this.modelReservation(inputEstimate);
    const remaining = this.remaining();
    if (tokens > remaining.tokens) throw new ReviewBudgetExceeded("tokens");
    if (remaining.costUsd !== undefined && (cost ?? 0) > remaining.costUsd)
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
    const measuredInput = Math.max(
      usage.inputTokens ?? 0,
      (usage.uncachedInputTokens ?? 0) +
        (usage.cachedInputTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0),
    );
    const measuredTokens = measuredInput + (usage.outputTokens ?? 0);
    this.tokens += measuredComplete
      ? measuredTokens
      : Math.max(reservation.tokens, measuredTokens);
    const pricing = this.pricing;
    if (pricing) {
      const pricedComplete =
        measuredComplete &&
        usage.uncachedInputTokens !== undefined &&
        usage.cachedInputTokens !== undefined &&
        usage.cacheWriteTokens !== undefined;
      const knownInput =
        (usage.uncachedInputTokens ?? 0) +
        (usage.cachedInputTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0);
      const estimatedInput = Math.max(
        usage.inputTokens ?? reservation.input,
        knownInput,
      );
      const unknownInput = estimatedInput - knownInput;
      const measuredCost =
        ((usage.uncachedInputTokens ?? 0) * pricing.inputUsdPerMillion +
          (usage.cachedInputTokens ?? 0) * pricing.cachedInputUsdPerMillion +
          (usage.cacheWriteTokens ?? 0) * pricing.cacheWriteUsdPerMillion +
          unknownInput *
            Math.max(
              pricing.inputUsdPerMillion,
              pricing.cachedInputUsdPerMillion,
              pricing.cacheWriteUsdPerMillion,
            ) +
          (usage.outputTokens ?? reservation.output) *
            pricing.outputUsdPerMillion) /
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
      ...(this.pricing
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

  /** Builds the shared worst-case reservation used for forecasting and dispatch admission. */
  private modelReservation(inputEstimate: number): Reservation {
    if (!Number.isSafeInteger(inputEstimate) || inputEstimate < 0)
      throw new Error("Invalid model input estimate");
    const output = this.options.maxOutputTokens;
    const pricing = this.pricing;
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
    return {
      input: inputEstimate,
      output,
      tokens: inputEstimate + output,
      cost,
    };
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
