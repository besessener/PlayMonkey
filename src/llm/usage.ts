import type { LlmConfig, LlmPricing } from "../config/config.ts";
import type { LlmErrorKind, LlmUsage } from "./provider.ts";

/** Counters for one role or the whole run. */
export interface LlmSummary {
  calls: number;
  failedCalls: number;
  /** Failed calls by error kind. */
  errors: Partial<Record<LlmErrorKind, number>>;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** Requests the SDK repeated after retryable errors; not counted as calls. */
  retries: number;
  /** Times the stuck detection handed over, by trigger. */
  handoffs: Partial<Record<string, number>>;
  /** Actions the LLM chose and the monkey executed. */
  actions: number;
  /** Steps where an LLM decision failed and the monkey acted instead, by reason. */
  fallbacks: Partial<Record<string, number>>;
  breakerTrips: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  /** Present with `llm.pricing`: an estimate, not a bill. */
  estimatedCost?: number;
}

/** The `llm` section of the report. */
export interface LlmReport {
  provider: string;
  deployment: string;
  /** `disabled`: the preflight failed with `llm.required: false`; the run was a pure monkey. */
  status: "active" | "disabled";
  disabledReason?: string;
  preflight?: { ok: boolean; latencyMs?: number; error?: string };
  budget: { maxCalls?: number; maxTokens?: number; exhausted?: { role: string; step: number; reason: string } };
  /** Echo of `llm.pricing`, so the estimate can be checked. */
  pricing?: LlmPricing;
  total: LlmSummary;
  roles: (LlmSummary & { role: string })[];
}

export interface CallRecord {
  ok: boolean;
  kind?: LlmErrorKind;
  usage?: LlmUsage;
  latencyMs: number;
  retries: number;
}

class Counters {
  calls = 0;
  failedCalls = 0;
  errors: Partial<Record<LlmErrorKind, number>> = {};
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  cacheWriteTokens = 0;
  retries = 0;
  handoffs: Partial<Record<string, number>> = {};
  actions = 0;
  fallbacks: Partial<Record<string, number>> = {};
  breakerTrips = 0;
  latencies: number[] = [];

  get tokens(): number {
    return this.inputTokens + this.outputTokens + this.cachedTokens + this.cacheWriteTokens;
  }

  summary(pricing: LlmPricing | undefined): LlmSummary {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const avg = sorted.length === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    // Nearest-rank percentile.
    const p95 = sorted.length === 0 ? 0 : (sorted[Math.ceil(0.95 * sorted.length) - 1] as number);
    const summary: LlmSummary = {
      calls: this.calls,
      failedCalls: this.failedCalls,
      errors: { ...this.errors },
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: this.cachedTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      retries: this.retries,
      handoffs: { ...this.handoffs },
      actions: this.actions,
      fallbacks: { ...this.fallbacks },
      breakerTrips: this.breakerTrips,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: Math.round(p95),
    };
    if (pricing !== undefined) summary.estimatedCost = estimateCost(summary, pricing);
    return summary;
  }
}

/**
 * LLM usage of a run, per run (role, or role/seed with `seeds`) and in total, and the run's budget (`llm.maxCalls`,
 * `llm.maxTokens`). One instance is shared by all runs, also parallel ones, so the budget covers the whole
 * invocation. The preflight probe is not counted.
 */
export class LlmStats {
  readonly #config: LlmConfig;
  readonly #provider: string;
  readonly #total = new Counters();
  readonly #roles = new Map<string, Counters>();
  #disabled: string | undefined;
  #preflight: LlmReport["preflight"];
  #exhausted: { role: string; step: number; reason: string } | undefined;
  /** Calls started (`begin`) but not yet recorded (`call`); parallel runs count them against `llm.maxCalls`. */
  #pending = 0;

  constructor(config: LlmConfig, provider: string) {
    this.#config = config;
    this.#provider = provider;
  }

  get active(): boolean {
    return this.#disabled === undefined;
  }

  get exhausted(): boolean {
    return this.#exhausted !== undefined;
  }

  disable(reason: string): void {
    this.#disabled = reason;
  }

  setPreflight(preflight: NonNullable<LlmReport["preflight"]>): void {
    this.#preflight = preflight;
  }

  /** Why the budget does not allow another call, or undefined. */
  budgetProblem(): string | undefined {
    const { maxCalls, maxTokens } = this.#config;
    if (maxCalls !== undefined && this.#total.calls + this.#pending >= maxCalls)
      return `llm.maxCalls (${maxCalls}) reached`;
    if (maxTokens !== undefined && this.#total.tokens >= maxTokens) return `llm.maxTokens (${maxTokens}) reached`;
    return undefined;
  }

  /** Records that the budget ran out; only the first time counts. */
  exhaust(role: string, step: number, reason: string): void {
    this.#exhausted ??= { role, step, reason };
  }

  /** Reserves a call against the budget until `call` records it; check `budgetProblem` first. */
  begin(): void {
    this.#pending++;
  }

  call(role: string, record: CallRecord): void {
    if (this.#pending > 0) this.#pending--;
    for (const counters of this.#both(role)) {
      counters.calls++;
      counters.retries += record.retries;
      counters.latencies.push(record.latencyMs);
      if (!record.ok) {
        counters.failedCalls++;
        const kind = record.kind ?? "other";
        counters.errors[kind] = (counters.errors[kind] ?? 0) + 1;
      }
      if (record.usage !== undefined) {
        counters.inputTokens += record.usage.inputTokens;
        counters.outputTokens += record.usage.outputTokens;
        counters.cachedTokens += record.usage.cachedTokens ?? 0;
        counters.cacheWriteTokens += record.usage.cacheWriteTokens ?? 0;
      }
    }
  }

  handoff(role: string, trigger: string): void {
    for (const counters of this.#both(role)) counters.handoffs[trigger] = (counters.handoffs[trigger] ?? 0) + 1;
  }

  action(role: string): void {
    for (const counters of this.#both(role)) counters.actions++;
  }

  fallback(role: string, reason: string): void {
    for (const counters of this.#both(role)) counters.fallbacks[reason] = (counters.fallbacks[reason] ?? 0) + 1;
  }

  breakerTrip(role: string): void {
    for (const counters of this.#both(role)) counters.breakerTrips++;
  }

  role(role: string): LlmSummary {
    return (this.#roles.get(role) ?? new Counters()).summary(this.#config.pricing);
  }

  report(): LlmReport {
    const pricing = this.#config.pricing;
    return {
      provider: this.#provider,
      deployment: this.#config.deployment,
      status: this.#disabled === undefined ? "active" : "disabled",
      ...(this.#disabled === undefined ? {} : { disabledReason: this.#disabled }),
      ...(this.#preflight === undefined ? {} : { preflight: this.#preflight }),
      budget: {
        ...(this.#config.maxCalls === undefined ? {} : { maxCalls: this.#config.maxCalls }),
        ...(this.#config.maxTokens === undefined ? {} : { maxTokens: this.#config.maxTokens }),
        ...(this.#exhausted === undefined ? {} : { exhausted: this.#exhausted }),
      },
      ...(pricing === undefined ? {} : { pricing: { ...pricing } }),
      total: this.#total.summary(pricing),
      roles: [...this.#roles].map(([role, counters]) => ({ role, ...counters.summary(pricing) })),
    };
  }

  #both(role: string): Counters[] {
    let counters = this.#roles.get(role);
    if (counters === undefined) {
      counters = new Counters();
      this.#roles.set(role, counters);
    }
    return [this.#total, counters];
  }
}

/** Cache reads and writes are priced at the input price unless their own price is given. */
export function estimateCost(
  usage: Pick<LlmSummary, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens">,
  pricing: LlmPricing,
): number {
  const cost =
    usage.inputTokens * pricing.inputPerMTok +
    usage.outputTokens * pricing.outputPerMTok +
    usage.cachedTokens * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
    usage.cacheWriteTokens * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok);
  // Prices are per million tokens; keep six decimals.
  return Math.round(cost) / 1e6;
}

/** One line for the console, e.g. `llm: 4 calls (1 failed), 12345 in / 678 out tokens, 2 handoffs, 1 fallback`. */
export function describeUsage(summary: LlmSummary): string {
  const sum = (counts: Partial<Record<string, number>>) =>
    Object.values(counts).reduce<number>((total, count) => total + (count ?? 0), 0);
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const parts = [
    `${summary.calls} call${summary.calls === 1 ? "" : "s"}${summary.failedCalls > 0 ? ` (${summary.failedCalls} failed)` : ""}`,
    `${summary.inputTokens} in / ${summary.outputTokens} out tokens${summary.cachedTokens > 0 ? ` (${summary.cachedTokens} cached)` : ""}`,
    plural(sum(summary.handoffs), "handoff"),
    plural(summary.actions, "action"),
  ];
  const fallbacks = sum(summary.fallbacks);
  if (fallbacks > 0) parts.push(`${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`);
  if (summary.breakerTrips > 0) parts.push(`breaker tripped ${summary.breakerTrips}×`);
  if (summary.calls > 0) parts.push(`p95 ${summary.p95LatencyMs} ms`);
  if (summary.estimatedCost !== undefined) parts.push(`est. cost ${summary.estimatedCost}`);
  return `llm: ${parts.join(", ")}`;
}
