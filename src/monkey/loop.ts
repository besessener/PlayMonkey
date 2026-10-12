import type { BrowserContext } from "playwright";
import type { Config } from "../config/config.ts";
import { durableLocator, type Snapshot, snapshot } from "../snapshot/snapshot.ts";
import { type Action, isElementAction } from "./actions.ts";
import { chooseAction, Exploration } from "./chooser.ts";
import { type ActionResult, executeAction, type Tabs } from "./executor.ts";
import { Random } from "./random.ts";

/** One executed step, handed to the action log. */
export interface StepRecord {
  step: number;
  action: Action;
  /** Durable locator of the element acted on, e.g. `getByRole('link', { name: 'Home' })`. */
  locator?: string;
  /** URL and snapshot hash of the state the action was chosen in. */
  url: string;
  snapshotHash: string;
  source: "monkey";
  result: ActionResult;
}

export type StopReason = "maxSteps" | "maxMinutes" | "aborted" | "error";

export interface RunResult {
  steps: number;
  stopReason: StopReason;
  /** Set when `stopReason` is `error`. */
  error?: string;
  durationMs: number;
  /** Distinct (URL, snapshot hash) states seen. */
  states: number;
  failedActions: number;
}

export interface RunOptions {
  config: Config;
  /** Receives every step right after it was executed. */
  onStep?: (record: StepRecord, snapshot: Snapshot) => void | Promise<void>;
  /** Stops the run before the next step, e.g. on Ctrl+C. */
  signal?: AbortSignal;
  /** Clock for the time limit; tests replace it. */
  now?: () => number;
}

/**
 * Runs the seeded random monkey in the context's first page until `maxSteps`, `maxMinutes` or the signal. Failed
 * actions are recorded and the run continues; only losing the browser itself ends it with `error`.
 */
export async function runMonkey(context: BrowserContext, options: RunOptions): Promise<RunResult> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + config.limits.maxMinutes * 60_000;
  const random = new Random(config.seed);
  const exploration = new Exploration();
  const origin = config.stayOnDomain ? new URL(config.baseUrl).origin : undefined;
  const tabs: Tabs = { context, current: 0 };
  let failedActions = 0;
  let step = 0;

  const finish = (stopReason: StopReason, error?: string): RunResult => ({
    steps: step,
    stopReason,
    ...(error === undefined ? {} : { error }),
    durationMs: now() - started,
    states: exploration.states.size,
    failedActions,
  });

  try {
    const first = context.pages()[0] ?? (await context.newPage());
    if (first.url() === "about:blank") await first.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 });

    while (true) {
      if (options.signal?.aborted) return finish("aborted");
      if (step >= config.limits.maxSteps) return finish("maxSteps");
      if (now() >= deadline) return finish("maxMinutes");

      const page = context.pages()[tabs.current] ?? context.pages()[0];
      if (page === undefined) return finish("error", "all pages were closed");
      if (origin !== undefined && !isOn(page.url(), origin)) {
        await page.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
      }

      const snap = await snapshot(page);
      exploration.visit(snap.url, snap.hash);
      const viewport = page.viewportSize() ?? { width: config.browser.viewport[0], height: config.browser.viewport[1] };
      const { action, elementKey } = chooseAction(snap, exploration, random, {
        weights: config.monkey.weights,
        testData: config.testData,
        ...(origin === undefined ? {} : { origin }),
        tabCount: context.pages().length,
        currentTab: tabs.current,
        viewport,
      });
      const locator = isElementAction(action)
        ? await durableLocator(page, action.ref).catch(() => undefined)
        : undefined;
      if (elementKey !== undefined) exploration.recordAction(`${snap.url}#${snap.hash}`, elementKey);

      step++;
      const result = await executeAction(tabs, action, config.monkey.actionTimeoutMs);
      tabs.current = result.tab;
      if (!result.ok) failedActions++;
      await options.onStep?.(
        {
          step,
          action,
          ...(locator === undefined ? {} : { locator }),
          url: snap.url,
          snapshotHash: snap.hash,
          source: "monkey",
          result,
        },
        snap,
      );
    }
  } catch (error) {
    return finish("error", error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
}

function isOn(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
