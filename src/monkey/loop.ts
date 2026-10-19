import type { BrowserContext, Page } from "playwright";
import type { Config } from "../config/config.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import type { Action } from "./actions.ts";
import { Exploration } from "./chooser.ts";
import { PageEvents, type StepEvent } from "./events.ts";
import { type ActionResult, executeAction, type Tabs } from "./executor.ts";
import { type Choice, type ChoosingRun, nextAction } from "./next-action.ts";
import { closeExtraTabs, leftSite, openStartPage, pageForStep, readPage } from "./pages.ts";
import { Random } from "./random.ts";
import { UrlScope } from "./scope.ts";
import type { Spectator } from "./spectator.ts";
import { STOPPED, untilDeadline } from "./timeout.ts";

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
  /** Stops the run, e.g. on Ctrl+C: before the next step, or during one that does not finish. */
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
  /** The action for `step`, or undefined to let the monkey choose; `page` is the page of the snapshot. */
  choose(snapshot: Snapshot, step: number, page: Page): Promise<Action | undefined>;
  /** Every executed step, with the snapshot it was chosen in. */
  record(record: StepRecord, snapshot: Snapshot): void;
}

/**
 * Runs the seeded random monkey in the context's first page until `maxSteps`, `maxMinutes` or the signal. Failed
 * actions are recorded and the run continues; only losing the browser itself ends it with `error`. With `replay`,
 * it executes the recorded actions instead, with the same page handling (stayOnDomain, crashes) as the original run.
 * A step still running at `maxMinutes` or the signal is abandoned, so a page that never answers cannot hold the run.
 *
 * Native dialogs, file choosers and downloads are handled on every page (`PageEvents`). When an action opens a
 * popup, the monkey continues in it; a popup that left the site is closed, and beyond `monkey.maxTabs` open tabs the
 * oldest ones the monkey left behind are closed.
 */
export async function runMonkey(context: BrowserContext, options: RunOptions): Promise<RunResult> {
  const run = startRun(context, options);
  try {
    return await loop(run);
  } catch (error) {
    return finish(run, "error", error instanceof Error ? error.message.split("\n")[0] : String(error));
  } finally {
    context.off("page", run.watch);
    run.events.detach();
  }
}

/** The state of one run, shared by its steps. */
interface Run extends ChoosingRun {
  readonly context: BrowserContext;
  readonly options: RunOptions;
  readonly now: () => number;
  readonly started: number;
  readonly deadline: number;
  readonly random: Random;
  readonly exploration: Exploration;
  readonly watch: (page: Page) => void;
  readonly events: PageEvents;
  /** The run has ended; an abandoned step must not record anything any more. */
  stopped: boolean;
  step: number;
  failedActions: number;
  skippedActions: number;
  /** An `offline` action took the context offline; the next step brings it back. */
  offline: boolean;
}

function startRun(context: BrowserContext, options: RunOptions): Run {
  const { config } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + config.limits.maxMinutes * 60_000;
  const random = new Random(config.seed);
  const exploration = new Exploration();
  const origin = config.stayOnDomain ? new URL(config.baseUrl).origin : undefined;
  const scope = new UrlScope(config.scope);
  const tabs: Tabs = { context, current: 0 };
  const unusable = new WeakSet<Page>();
  const watch = (page: Page) => {
    page.once("crash", () => unusable.add(page));
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  context.setDefaultTimeout(config.monkey.actionTimeoutMs);
  const events = new PageEvents(context, {
    seed: config.seed,
    timeoutMs: config.monkey.actionTimeoutMs,
    ...(options.downloadDir === undefined ? {} : { downloadDir: options.downloadDir }),
  });
  return {
    context,
    options,
    config,
    now,
    started,
    deadline,
    random,
    exploration,
    origin,
    scope,
    tabs,
    unusable,
    watch,
    events,
    stopped: false,
    step: 0,
    failedActions: 0,
    skippedActions: 0,
    offline: false,
  };
}

function finish(run: Run, stopReason: StopReason, error?: string): RunResult {
  return {
    steps: run.step,
    stopReason,
    ...(error === undefined ? {} : { error }),
    durationMs: run.now() - run.started,
    states: run.exploration.states.size,
    failedActions: run.failedActions,
    skippedActions: run.skippedActions,
  };
}

async function loop(run: Run): Promise<RunResult> {
  // Dialogs of the start page belong to the first step.
  run.events.beginStep(1, recordedEvents(run, 0));
  const started = await untilStopped(run, openStartPage(run));
  if (started === STOPPED) return stop(run);

  while (true) {
    const limit = limitReached(run);
    if (limit !== undefined) return finish(run, limit);
    const ended = await untilStopped(run, step(run));
    if (ended === STOPPED) return stop(run);
    if (ended !== undefined) return ended;
  }
}

/** One step: the page, its snapshot, the choice, the action and its record. A result ends the run. */
async function step(run: Run): Promise<RunResult | undefined> {
  const { context, options, tabs, events } = run;
  const page = await pageForStep(run);
  if (page === undefined) return finish(run, "error", "all pages were closed");
  tabs.current = Math.max(0, context.pages().indexOf(page));
  events.beginStep(run.step + 1, recordedEvents(run, run.step));
  if (await leftSite(run, page)) return undefined;
  const snap = await readPage(run, page);
  if (snap === undefined) return undefined;
  const isNewState = run.exploration.visit(snap.url, snap.hash);
  const advisor = options.replay === undefined ? options.advisor : undefined;
  advisor?.observe(snap, isNewState);
  const choice = await nextAction(run, page, snap, advisor);
  // Choosing can take long (the LLM): a limit reached meanwhile ends the run before the action.
  const limit = limitReached(run);
  if (limit !== undefined) return finish(run, limit);

  run.step++;
  if (typeof choice.targets === "string" && options.replay?.strict === true) {
    return finish(run, "error", `step ${run.step}: ${choice.targets}`);
  }
  const result = await executeStep(run, page, choice);
  await recordStep(run, { snap, choice, result, advisor });
  return undefined;
}

/** The work's result, or `STOPPED` when the signal or `maxMinutes` comes first. */
function untilStopped<T>(run: Run, work: Promise<T>): Promise<T | typeof STOPPED> {
  const { signal } = run.options;
  return untilDeadline(work, {
    ms: Math.max(0, run.deadline - run.now()),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Ends the run while a step is still in progress; that step records nothing any more. */
function stop(run: Run): RunResult {
  run.stopped = true;
  return finish(run, run.options.signal?.aborted === true ? "aborted" : "maxMinutes");
}

function recordedEvents(run: Run, index: number): StepEvent[] | undefined {
  return run.options.replay?.actions[index]?.events;
}

/** Why the run must stop before the next step, if it must. */
function limitReached(run: Run): "aborted" | "end" | "maxSteps" | "maxMinutes" | undefined {
  const { options } = run;
  if (options.signal?.aborted === true) return "aborted";
  if (options.replay !== undefined) {
    if (run.step >= options.replay.actions.length) return "end";
  } else if (run.step >= run.config.limits.maxSteps) return "maxSteps";
  if (run.now() >= run.deadline) return "maxMinutes";
  return undefined;
}

/** Executes the action, or skips it when replay cannot find its element; ends an `offline` step after the next one. */
async function executeStep(run: Run, page: Page, choice: Choice): Promise<ActionResult> {
  const wasOffline = run.offline;
  const result = await runAction(run, page, choice);
  run.offline = choice.action.type === "offline" && result.ok;
  if (wasOffline && !run.offline) await run.context.setOffline(false);
  return result;
}

async function runAction(run: Run, page: Page, { action, locator, targets }: Choice): Promise<ActionResult> {
  if (typeof targets === "string") {
    run.skippedActions++;
    return { ok: false, error: targets, navigated: false, url: page.url(), tab: run.tabs.current };
  }
  const { spectator } = run.options;
  const result = await executeAction(run.tabs, action, run.config.monkey.actionTimeoutMs, {
    targets,
    ...(spectator === undefined ? {} : { spectator: { ...spectator, ...(locator === undefined ? {} : { locator }) } }),
  });
  if (!result.ok) run.failedActions++;
  return result;
}

interface ExecutedStep {
  snap: Snapshot;
  choice: Choice;
  result: ActionResult;
  advisor: StepAdvisor | undefined;
}

/** Collects the step's page events, tidies up the tabs and hands the record on. */
async function recordStep(run: Run, { snap, choice, result, advisor }: ExecutedStep): Promise<void> {
  const { action, source, locator, toLocator, targets } = choice;
  const stepEvents = await run.events.collect();
  if (run.stopped) return;
  run.tabs.current = result.tab;
  await closeExtraTabs(run.tabs, run.config.monkey);
  result.tab = run.tabs.current;
  const record: StepRecord = {
    step: run.step,
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
  await run.options.onStep?.(record, snap);
}
