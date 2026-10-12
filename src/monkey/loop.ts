import type { BrowserContext, Locator, Page } from "playwright";
import type { Config } from "../config/config.ts";
import { findElement } from "../replay/locator.ts";
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
  source: ActionSource;
  result: ActionResult;
  /** Replay only: the recorded element could not be found, so the action was not executed. */
  skipped?: boolean;
}

/** Who chose an action. The LLM arrives with M2; replay keeps the recorded source. */
export type ActionSource = "monkey" | "llm";

/** A recorded action to replay. Element actions are found by `locator`; their ref is stale. */
export interface PlannedAction {
  action: Action;
  source: ActionSource;
  locator?: string;
}

export interface ReplayPlan {
  actions: PlannedAction[];
  /** End the run with `error` when a recorded element cannot be found, instead of skipping the action. */
  strict: boolean;
}

/** `end`: a replay executed its last action. */
export type StopReason = "maxSteps" | "maxMinutes" | "aborted" | "error" | "end";

export interface RunResult {
  steps: number;
  stopReason: StopReason;
  /** Set when `stopReason` is `error`. */
  error?: string;
  durationMs: number;
  /** Distinct (URL, snapshot hash) states seen. */
  states: number;
  failedActions: number;
  /** Replay only: actions skipped because their element was not found. */
  skippedActions: number;
}

export interface RunOptions {
  config: Config;
  /** Receives every step right after it was executed. */
  onStep?: (record: StepRecord, snapshot: Snapshot) => void | Promise<void>;
  /** Stops the run before the next step, e.g. on Ctrl+C. */
  signal?: AbortSignal;
  /** Clock for the time limit; tests replace it. */
  now?: () => number;
  /** Execute these recorded actions in order instead of choosing; `maxSteps` does not apply. */
  replay?: ReplayPlan;
}

/**
 * Runs the seeded random monkey in the context's first page until `maxSteps`, `maxMinutes` or the signal. Failed
 * actions are recorded and the run continues; only losing the browser itself ends it with `error`. With `replay`,
 * it executes the recorded actions instead, with the same page handling (stayOnDomain, crashes) as the original run.
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
  // A crashed page throws on every call; it is closed and the run continues (the crash oracle reports it).
  const crashed = new WeakSet<Page>();
  const watch = (page: Page) => page.once("crash", () => crashed.add(page));
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  let failedActions = 0;
  let skippedActions = 0;
  let step = 0;

  const finish = (stopReason: StopReason, error?: string): RunResult => ({
    steps: step,
    stopReason,
    ...(error === undefined ? {} : { error }),
    durationMs: now() - started,
    states: exploration.states.size,
    failedActions,
    skippedActions,
  });

  try {
    const first = context.pages()[0] ?? (await context.newPage());
    if (first.url() === "about:blank") await first.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 });

    while (true) {
      if (options.signal?.aborted) return finish("aborted");
      if (options.replay !== undefined) {
        if (step >= options.replay.actions.length) return finish("end");
      } else if (step >= config.limits.maxSteps) return finish("maxSteps");
      if (now() >= deadline) return finish("maxMinutes");

      let page = context.pages()[tabs.current] ?? context.pages()[0];
      if (page !== undefined && crashed.has(page)) {
        await page.close().catch(() => undefined);
        tabs.current = 0;
        page = context.pages()[0] ?? (await context.newPage());
        if (page.url() === "about:blank")
          await page.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
      }
      if (page === undefined) return finish("error", "all pages were closed");
      if (origin !== undefined && !isOn(page.url(), origin)) {
        await page.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
      }

      let snap: Snapshot;
      try {
        snap = await snapshot(page);
      } catch (error) {
        // The page crashed while being read: start over on a fresh one.
        if (crashed.has(page)) continue;
        throw error;
      }
      exploration.visit(snap.url, snap.hash);

      let action: Action;
      let source: ActionSource = "monkey";
      let locator: string | undefined;
      // Replay: the recorded element, or why it cannot be found.
      let target: Locator | string | undefined;
      if (options.replay === undefined) {
        const viewport = page.viewportSize() ?? {
          width: config.browser.viewport[0],
          height: config.browser.viewport[1],
        };
        const choice = chooseAction(snap, exploration, random, {
          weights: config.monkey.weights,
          testData: config.testData,
          ...(origin === undefined ? {} : { origin }),
          tabCount: context.pages().length,
          currentTab: tabs.current,
          viewport,
        });
        action = choice.action;
        locator = isElementAction(action) ? await durableLocator(page, action.ref).catch(() => undefined) : undefined;
        if (choice.elementKey !== undefined) exploration.recordAction(`${snap.url}#${snap.hash}`, choice.elementKey);
      } else {
        const planned = options.replay.actions[step] as PlannedAction;
        ({ action, source, locator } = planned);
        if (isElementAction(action)) target = await findElement(page, locator, config.monkey.actionTimeoutMs);
      }

      step++;
      let result: ActionResult;
      if (typeof target === "string") {
        if (options.replay?.strict) return finish("error", `step ${step}: ${target}`);
        skippedActions++;
        result = { ok: false, error: target, navigated: false, url: page.url(), tab: tabs.current };
      } else {
        result = await executeAction(tabs, action, config.monkey.actionTimeoutMs, target);
        if (!result.ok) failedActions++;
      }
      tabs.current = result.tab;
      await options.onStep?.(
        {
          step,
          action,
          ...(locator === undefined ? {} : { locator }),
          url: snap.url,
          snapshotHash: snap.hash,
          source,
          result,
          ...(typeof target === "string" ? { skipped: true } : {}),
        },
        snap,
      );
    }
  } catch (error) {
    return finish("error", error instanceof Error ? error.message.split("\n")[0] : String(error));
  } finally {
    context.off("page", watch);
  }
}

function isOn(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
