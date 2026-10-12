import type { LlmConfig } from "../config/config.ts";
import { type Action, describeAction } from "../monkey/actions.ts";
import type { StepRecord } from "../monkey/loop.ts";
import { serializeSnapshot } from "../snapshot/serialize.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import type { DebugEntry, DebugLog } from "./debug-log.ts";
import type { PromptPlaceholders } from "./placeholders.ts";
import {
  type DecideInput,
  type DecideResult,
  type Decision,
  type HistoryEntry,
  LlmError,
  type LlmProvider,
  RESPONSE_ERRORS,
} from "./provider.ts";
import type { StuckDetector } from "./stuck.ts";
import type { LlmStats } from "./usage.ts";

/**
 * The circuit breaker, shared by all runs of an invocation: failures in a row count across runs, and a trip pauses
 * the LLM for `llm.breaker.pauseSteps` steps in every run (counted in each run's own steps).
 */
export class LlmBreaker {
  failures = 0;
  /** Incremented on every trip; a driver that has not seen the latest trip pauses. */
  trips = 0;
}

export interface LlmDriverOptions {
  provider: LlmProvider;
  config: LlmConfig;
  stats: LlmStats;
  detector: StuckDetector;
  placeholders: PromptPlaceholders;
  /** The role name, shown to the LLM. */
  role: string;
  /** Key for usage statistics and the debug log: the role, or `role/seed` with `seeds`. Default: `role`. */
  run?: string;
  /** Shared by parallel runs; default: one of its own. */
  breaker?: LlmBreaker;
  /** One line per finding so far, for the prompt. */
  findings: () => string[];
  /** Origin the run must stay on, or undefined when `stayOnDomain` is off. */
  origin?: string;
  debugLog?: DebugLog;
  log: (line: string) => void;
  now?: () => number;
}

/**
 * Lets the LLM choose when the monkey is stuck, and never lets an LLM problem stop the run. Per step the loop calls
 * `observe` with the snapshot, then `choose` (an action, or undefined for the monkey), then `record` with the
 * executed step.
 *
 * A handoff gives the LLM up to `llm.handoff.maxDecisions` decisions in a row, ended early by `done`; then the
 * monkey has at least `cooldownSteps` steps. A bad response (no or an invalid tool call, refusal, truncation) is
 * retried once; any failed decision falls back to a monkey action for that step. After `llm.breaker.failures`
 * failed decisions in a row the LLM pauses for `llm.breaker.pauseSteps` steps. When the budget runs out, the rest
 * of the run is a pure monkey.
 */
export class LlmDriver {
  readonly #o: LlmDriverOptions;
  readonly #now: () => number;
  readonly #history: HistoryEntry[] = [];
  #decisionsLeft = 0;
  #goal = "";
  #cooldownUntil = 0;
  #pausedUntil = 0;
  readonly #breaker: LlmBreaker;
  #tripsSeen = 0;
  /** The LLM's own description of its last action, with placeholders instead of filled-in values. */
  #chosen: { step: number; text: string } | undefined;

  constructor(options: LlmDriverOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#breaker = options.breaker ?? new LlmBreaker();
    this.#tripsSeen = this.#breaker.trips;
  }

  observe(snapshot: Snapshot, isNewState: boolean): void {
    this.#o.detector.observe(snapshot, isNewState);
  }

  /** The LLM's action for `step`, or undefined when the monkey decides. */
  async choose(snapshot: Snapshot, step: number): Promise<Action | undefined> {
    const { stats, config } = this.#o;
    const role = this.#o.run ?? this.#o.role;
    if (this.#breaker.trips !== this.#tripsSeen) {
      // Another run tripped the shared breaker.
      this.#tripsSeen = this.#breaker.trips;
      this.#pausedUntil = Math.max(this.#pausedUntil, step + config.breaker.pauseSteps);
      this.#decisionsLeft = 0;
    }
    if (!stats.active || stats.exhausted || step < this.#pausedUntil) return undefined;
    if (this.#decisionsLeft === 0) {
      if (step < this.#cooldownUntil) return undefined;
      const stuck = this.#o.detector.check(snapshot);
      if (stuck === undefined) return undefined;
      this.#decisionsLeft = config.handoff.maxDecisions;
      this.#goal = stuck.detail;
      stats.handoff(role, stuck.trigger);
      this.#o.log(`step ${step}: handing over to the LLM: ${this.#o.placeholders.hide(stuck.detail)}`);
    }

    const input = this.#input(snapshot);
    let failure: LlmError | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const problem = stats.budgetProblem();
      if (problem !== undefined) {
        stats.exhaust(role, step, problem);
        this.#o.log(`step ${step}: ${problem}; continuing as pure monkey`);
        this.#end(step);
        return undefined;
      }
      stats.begin();
      const started = this.#now();
      try {
        const result = await this.#o.provider.decide(input);
        const action = this.#accepted(result, snapshot);
        stats.call(role, { ok: true, usage: result.usage, latencyMs: this.#now() - started, retries: result.retries });
        await this.#debug({ role, step, attempt, input, result: result.decision, raw: result.raw });
        this.#breaker.failures = 0;
        this.#decisionsLeft--;
        if (action === undefined) {
          this.#end(step);
          return undefined;
        }
        if (this.#decisionsLeft === 0) this.#end(step);
        stats.action(role);
        this.#chosen = { step, text: describeAction(action) };
        return this.#o.placeholders.fillDecision(action) as Action;
      } catch (error) {
        failure = error instanceof LlmError ? error : new LlmError("other", messageOf(error));
        stats.call(role, {
          ok: false,
          kind: failure.kind,
          ...(failure.usage === undefined ? {} : { usage: failure.usage }),
          latencyMs: this.#now() - started,
          retries: failure.retries,
        });
        await this.#debug({
          role,
          step,
          attempt,
          input,
          error: `${failure.kind}: ${failure.message}`,
          raw: failure.raw,
        });
        if (!RESPONSE_ERRORS.has(failure.kind)) break;
      }
    }

    const reason = (failure as LlmError).kind;
    stats.fallback(role, reason);
    this.#o.log(
      `step ${step}: LLM failed (${reason}: ${this.#o.placeholders.hide(failure?.message ?? "")}); monkey acts`,
    );
    this.#decisionsLeft--;
    this.#breaker.failures++;
    if (this.#breaker.failures >= config.breaker.failures) {
      this.#breaker.failures = 0;
      this.#breaker.trips++;
      this.#tripsSeen = this.#breaker.trips;
      this.#pausedUntil = step + 1 + config.breaker.pauseSteps;
      stats.breakerTrip(role);
      this.#o.log(
        `step ${step}: ${config.breaker.failures} LLM failures in a row; pausing the LLM for ${config.breaker.pauseSteps} steps`,
      );
      this.#decisionsLeft = 0;
    }
    if (this.#decisionsLeft === 0) this.#end(step);
    return undefined;
  }

  record(record: StepRecord, snapshot: Snapshot): void {
    this.#o.detector.record(record, snapshot);
    const text =
      record.source === "llm" && this.#chosen?.step === record.step ? this.#chosen.text : describeAction(record.action);
    this.#history.push({
      step: record.step,
      source: record.source,
      action: this.#o.placeholders.hide(text),
      ok: record.result.ok,
      ...(record.result.error === undefined ? {} : { error: this.#o.placeholders.hide(record.result.error) }),
      url: this.#o.placeholders.hide(record.url),
    });
    if (this.#history.length > this.#o.config.historyActions) this.#history.shift();
  }

  #input(snapshot: Snapshot): DecideInput {
    const { placeholders, config } = this.#o;
    return {
      snapshot: placeholders.hide(serializeSnapshot(snapshot, { maxChars: config.snapshotChars })),
      refs: new Set(snapshot.elements.map((element) => element.ref)),
      history: [...this.#history],
      findingsSoFar: this.#o
        .findings()
        .slice(0, 20)
        .map((line) => placeholders.hide(line)),
      goal: placeholders.hide(this.#goal),
      testDataKeys: placeholders.testDataKeys,
      placeholders: placeholders.offered,
      role: placeholders.hide(this.#o.role),
    };
  }

  /** `#accept`, keeping the usage of the call when the decision is rejected. */
  #accepted(result: DecideResult, snapshot: Snapshot): Action | undefined {
    try {
      return this.#accept(result.decision, snapshot);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      throw new LlmError(error.kind, error.message, { usage: result.usage, retries: result.retries, raw: result.raw });
    }
  }

  /** Checks what the provider cannot know: navigation targets. Returns undefined for `done`. */
  #accept(decision: Decision, snapshot: Snapshot): Action | undefined {
    if (decision.type === "done") return undefined;
    if (decision.type !== "navigate") return decision;
    let target: URL;
    try {
      target = new URL(this.#o.placeholders.fill(decision.url), snapshot.url);
    } catch {
      throw new LlmError("invalid", "tool navigate: url is not a valid URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new LlmError("invalid", "tool navigate: only http(s) URLs are allowed");
    }
    if (this.#o.origin !== undefined && target.origin !== this.#o.origin) {
      throw new LlmError("invalid", "tool navigate: the URL leaves the site under test (stayOnDomain)");
    }
    return { type: "navigate", url: target.href };
  }

  /** A debug log that cannot be written must not count as an LLM failure. */
  async #debug(entry: DebugEntry): Promise<void> {
    await this.#o.debugLog?.write(entry).catch((error: unknown) => {
      this.#o.log(`llm.debugLog: cannot write ${this.#o.debugLog?.file}: ${messageOf(error)}`);
    });
  }

  #end(step: number): void {
    this.#decisionsLeft = 0;
    this.#cooldownUntil = step + 1 + this.#o.config.handoff.cooldownSteps;
    this.#o.detector.reset();
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown error";
}
