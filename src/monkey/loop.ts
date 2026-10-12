import type { BrowserContext, Page } from "playwright";
import type { Config } from "../config/config.ts";
import { findElement } from "../replay/locator.ts";
import { durableLocator, type Snapshot, snapshot } from "../snapshot/snapshot.ts";
import { type Action, isElementAction } from "./actions.ts";
import { chooseAction, Exploration } from "./chooser.ts";
import { PageEvents, type StepEvent } from "./events.ts";
import { type ActionResult, executeAction, installPopupProbe, type Tabs, type Targets } from "./executor.ts";
import { Random } from "./random.ts";
import type { Spectator } from "./spectator.ts";

/** One executed step, handed to the action log. */
export interface StepRecord {
  step: number;
  action: Action;
  /** Durable locator of the element acted on, e.g. `getByRole('link', { name: 'Home' })`. */
  locator?: string;
  /** Durable locator of the drop target of a `drag`. */
  toLocator?: string;
  /** Dialogs answered, files uploaded and downloads during the step. */
  events?: StepEvent[];
  /** URL and snapshot hash of the state the action was chosen in. */
  url: string;
  snapshotHash: string;
  source: ActionSource;
  result: ActionResult;
  /** Replay only: the recorded element could not be found, so the action was not executed. */
  skipped?: boolean;
}

/** Who chose an action. Replay keeps the recorded source. */
export type ActionSource = "monkey" | "llm";

/** A recorded action to replay. Element actions are found by `locator`; their ref is stale. */
export interface PlannedAction {
  action: Action;
  source: ActionSource;
  locator?: string;
  toLocator?: string;
  /** The recorded answers to dialogs and file choosers, given again. */
  events?: StepEvent[];
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
  /** Takes over steps when the monkey is stuck (the LLM); ignored with `replay`. */
  advisor?: StepAdvisor;
  /** Spectator mode: outline each element before acting on it. */
  spectator?: Spectator;
  /** Where downloads are saved; without it, they are measured and deleted at once. */
  downloadDir?: string;
}

/** Something that may choose a step instead of the random monkey; see `LlmDriver`. */
export interface StepAdvisor {
  /** Every new snapshot, before choosing; `isNewState` when its (URL, hash) state is new in this run. */
  observe(snapshot: Snapshot, isNewState: boolean): void;
  /** The action for `step`, or undefined to let the monkey choose. */
  choose(snapshot: Snapshot, step: number): Promise<Action | undefined>;
  /** Every executed step, with the snapshot it was chosen in. */
  record(record: StepRecord, snapshot: Snapshot): void;
}

/**
 * Runs the seeded random monkey in the context's first page until `maxSteps`, `maxMinutes` or the signal. Failed
 * actions are recorded and the run continues; only losing the browser itself ends it with `error`. With `replay`,
 * it executes the recorded actions instead, with the same page handling (stayOnDomain, crashes) as the original run.
 *
 * Native dialogs, file choosers and downloads are handled on every page (`PageEvents`). When an action opens a
 * popup, the monkey continues in it; a popup that left the site is closed, and beyond `monkey.maxTabs` open tabs the
 * oldest ones the monkey left behind are closed.
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
  const events = new PageEvents(context, {
    seed: config.seed,
    timeoutMs: config.monkey.actionTimeoutMs,
    ...(options.downloadDir === undefined ? {} : { downloadDir: options.downloadDir }),
  });
  const recordedEvents = (index: number) => options.replay?.actions[index]?.events;
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
    // Dialogs of the start page belong to the first step.
    events.beginStep(1, recordedEvents(0));
    await installPopupProbe(context);
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
      tabs.current = Math.max(0, context.pages().indexOf(page));
      events.beginStep(step + 1, recordedEvents(step));
      if (origin !== undefined && !isOn(page.url(), origin)) {
        if (tabs.current > 0) {
          // A popup that left the site (or never reached it): close it and go on in the first tab.
          await page.close().catch(() => undefined);
          tabs.current = 0;
          continue;
        }
        await page.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
      }

      let snap: Snapshot;
      try {
        snap = await snapshot(page);
      } catch (error) {
        // The page crashed while being read: start over on a fresh one.
        if (crashed.has(page)) continue;
        // It closed itself (`window.close()` in a popup) while being read: go on in another tab. Without any page
        // left, the next round ends the run.
        if (page.isClosed()) {
          tabs.current = 0;
          continue;
        }
        throw error;
      }
      const isNewState = exploration.visit(snap.url, snap.hash);
      const advisor = options.replay === undefined ? options.advisor : undefined;
      advisor?.observe(snap, isNewState);

      let action: Action;
      let source: ActionSource = "monkey";
      let locator: string | undefined;
      let toLocator: string | undefined;
      // Replay: the recorded elements, or why one cannot be found.
      let targets: Targets | string = {};
      const advised = await advisor?.choose(snap, step + 1);
      if (advised !== undefined) {
        action = advised;
        source = "llm";
        locator = isElementAction(action) ? await durableLocator(page, action.ref).catch(() => undefined) : undefined;
      } else if (options.replay === undefined) {
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
        ({ action, source, locator, toLocator } = planned);
        if (isElementAction(action)) targets = await findTargets(page, planned, config.monkey.actionTimeoutMs);
      }
      if (action.type === "drag" && options.replay === undefined) {
        toLocator = await durableLocator(page, action.toRef).catch(() => undefined);
      }

      step++;
      let result: ActionResult;
      if (typeof targets === "string") {
        if (options.replay?.strict) return finish("error", `step ${step}: ${targets}`);
        skippedActions++;
        result = { ok: false, error: targets, navigated: false, url: page.url(), tab: tabs.current };
      } else {
        const spectator =
          options.spectator === undefined
            ? undefined
            : { ...options.spectator, ...(locator === undefined ? {} : { locator }) };
        result = await executeAction(tabs, action, config.monkey.actionTimeoutMs, targets, spectator);
        if (!result.ok) failedActions++;
      }
      const stepEvents = await events.collect();
      tabs.current = result.tab;
      await closeExtraTabs(tabs, config.monkey.maxTabs);
      result.tab = tabs.current;
      const record: StepRecord = {
        step,
        action,
        ...(locator === undefined ? {} : { locator }),
        ...(toLocator === undefined ? {} : { toLocator }),
        ...(stepEvents.length === 0 ? {} : { events: stepEvents }),
        url: snap.url,
        snapshotHash: snap.hash,
        source,
        result,
        ...(typeof targets === "string" ? { skipped: true } : {}),
      };
      advisor?.record(record, snap);
      await options.onStep?.(record, snap);
    }
  } catch (error) {
    return finish("error", error instanceof Error ? error.message.split("\n")[0] : String(error));
  } finally {
    context.off("page", watch);
    events.detach();
  }
}

/** Replay: the recorded element of an action and, for `drag`, its drop target; or why one cannot be found. */
async function findTargets(page: Page, planned: PlannedAction, timeoutMs: number): Promise<Targets | string> {
  const element = await findElement(page, planned.locator, timeoutMs);
  if (typeof element === "string") return element;
  if (planned.action.type !== "drag") return { element };
  const to = await findElement(page, planned.toLocator, timeoutMs);
  return typeof to === "string" ? `drop target: ${to}` : { element, to };
}

/**
 * Keeps at most `maxTabs` pages open: closes the oldest ones other than the first and the current, which the monkey
 * left behind (popups pile up quickly). Keeps `tabs.current` on the same page.
 */
async function closeExtraTabs(tabs: Tabs, maxTabs: number): Promise<void> {
  const pages = tabs.context.pages();
  if (pages.length <= maxTabs) return;
  const current = pages[tabs.current];
  const closable = pages.filter((page, index) => index > 0 && page !== current);
  for (const page of closable.slice(0, pages.length - maxTabs)) await page.close().catch(() => undefined);
  tabs.current = Math.max(0, current === undefined ? 0 : tabs.context.pages().indexOf(current));
}

function isOn(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
