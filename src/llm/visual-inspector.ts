import type { Page } from "playwright";
import type { LlmConfig } from "../config/config.ts";
import { normalizeUrl } from "../oracles/keys.ts";
import type { DebugLog } from "./debug-log.ts";
import { type InspectInput, LlmError, type LlmProvider, OUTAGE_ERRORS, type VisualKind } from "./provider.ts";
import type { Capture } from "./screenshot.ts";
import { callInTime, RunStopping, type TimeLimit } from "./time-limit.ts";
import type { LlmStats } from "./usage.ts";

/** A visual bug as the `visual` oracle files it. */
export interface VisualSignal {
  severity: "medium" | "low";
  key: string;
  message: string;
  url: string;
  details: { kind: VisualKind; description: string };
}

export interface VisualInspectorOptions {
  provider: LlmProvider;
  config: LlmConfig;
  stats: LlmStats;
  /** Key for usage statistics: the role, or `role/seed`. */
  run: string;
  /** The page for the LLM, every secret blacked out (`maskedScreenshot`). */
  capture: (page: Page) => Promise<Capture>;
  /** Origin of the site under test, dropped from keys. */
  origin: string;
  log: (line: string) => void;
  debugLog?: DebugLog | undefined;
  signal?: AbortSignal | undefined;
  deadline?: number | undefined;
  now?: () => number;
}

/** A layout problem is a nuisance; the others hide content or controls from the user. */
const SEVERITY: Record<VisualKind, VisualSignal["severity"]> = {
  overlap: "medium",
  "cut-off": "medium",
  unreadable: "medium",
  "broken-image": "medium",
  misplaced: "low",
};

/**
 * The `visual` oracle's eyes: asks the LLM about a masked screenshot of every page of a run once, by its normalized
 * URL, within the shared LLM budget. Never throws and never stops the run: a page that cannot be captured safely is
 * skipped, and after `llm.breaker.failures` failed checks in a row, or one outage, the checks end for this run.
 */
export class VisualInspector {
  readonly #o: VisualInspectorOptions;
  readonly #limit: TimeLimit;
  readonly #checked = new Set<string>();
  #failures = 0;
  #off = false;

  constructor(options: VisualInspectorOptions) {
    this.#o = options;
    const now = options.now ?? Date.now;
    this.#limit = { timeoutMs: options.config.timeoutMs, signal: options.signal, deadline: options.deadline, now };
  }

  /** The visual bugs of `page`, checked at `step`; none when it was checked before or cannot be checked. */
  async inspect(page: Page, step: number): Promise<VisualSignal[]> {
    const { stats } = this.#o;
    const url = page.url();
    const path = normalizeUrl(url, this.#o.origin);
    if (this.#off || !stats.active || stats.exhausted || this.#checked.has(path)) return [];
    this.#checked.add(path);
    const problem = stats.budgetProblem();
    if (problem !== undefined) {
      stats.exhaust(this.#o.run, step, problem);
      return [];
    }
    const capture = await this.#o.capture(page);
    if (!capture.ok) {
      this.#o.log(`step ${step}: visual check of ${path} skipped: ${capture.reason}`);
      return [];
    }
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const input: InspectInput = { page: path, viewport, screenshot: capture.screenshot };
    const bugs = await this.#ask(input, step);
    return bugs.map(({ kind, description }) => ({
      severity: SEVERITY[kind],
      key: `${path}|${kind}`,
      message: `${kind} on ${path}: ${description}`,
      url,
      details: { kind, description },
    }));
  }

  async #ask(input: InspectInput, step: number): Promise<{ kind: VisualKind; description: string }[]> {
    const { provider, stats, run } = this.#o;
    const now = this.#limit.now;
    stats.begin();
    const started = now();
    try {
      const result = await callInTime((options) => provider.inspect(input, options), this.#limit);
      stats.call(run, { ok: true, usage: result.usage, latencyMs: now() - started, retries: result.retries });
      await this.#debug({ role: run, step, attempt: 1, input, result: result.bugs, raw: result.raw });
      this.#failures = 0;
      return result.bugs;
    } catch (error) {
      if (error instanceof RunStopping) {
        stats.cancel();
        return [];
      }
      const failure = error instanceof LlmError ? error : new LlmError("other", String(error));
      const usage = failure.usage === undefined ? {} : { usage: failure.usage };
      stats.call(run, {
        ok: false,
        kind: failure.kind,
        ...usage,
        latencyMs: now() - started,
        retries: failure.retries,
      });
      await this.#debug({ role: run, step, attempt: 1, input, error: `${failure.kind}: ${failure.message}` });
      this.#fail(step, failure);
      return [];
    }
  }

  #fail(step: number, failure: LlmError): void {
    this.#failures++;
    this.#o.log(`step ${step}: visual check failed (${failure.kind}: ${failure.message.split("\n")[0]})`);
    if (OUTAGE_ERRORS.has(failure.kind) || this.#failures >= this.#o.config.breaker.failures) {
      this.#off = true;
      this.#o.log(`step ${step}: visual checks off for the rest of this run`);
    }
  }

  /** A debug log that cannot be written must not count as an LLM failure. */
  async #debug(entry: Parameters<DebugLog["write"]>[0]): Promise<void> {
    await this.#o.debugLog?.write(entry).catch((error: unknown) => {
      this.#o.log(`llm.debugLog: cannot write ${this.#o.debugLog?.file}: ${String(error)}`);
    });
  }
}
