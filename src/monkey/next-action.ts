import type { BrowserContext, Page } from "playwright";
import { findElement } from "../replay/locator.ts";
import { durableLocator, type Snapshot } from "../snapshot/snapshot.ts";
import { type Action, isElementAction } from "./actions.ts";
import { chooseAction, type Exploration } from "./chooser.ts";
import type { Targets } from "./executor.ts";
import type { ActionSource, PlannedAction, ReplayPlan, RunOptions, StepAdvisor } from "./loop.ts";
import type { RunPages } from "./pages.ts";
import type { Random } from "./random.ts";
import { bounded } from "./timeout.ts";

/** What choosing the next action needs of a run. */
export interface ChoosingRun extends RunPages {
  readonly context: BrowserContext;
  readonly options: RunOptions;
  readonly random: Random;
  readonly exploration: Exploration;
  step: number;
}

/** What a step does, and how: chosen by the monkey or the LLM, or recorded for replay. */
export interface Choice {
  action: Action;
  source: ActionSource;
  locator: string | undefined;
  toLocator: string | undefined;
  /** Replay: the recorded elements, or why one cannot be found. */
  targets: Targets | string;
}

/** The next action: the advisor's, else the recorded one in replay, else the monkey's. */
export async function nextAction(
  run: ChoosingRun,
  page: Page,
  snap: Snapshot,
  advisor: StepAdvisor | undefined,
): Promise<Choice> {
  const advised = await advisor?.choose(snap, run.step + 1, page);
  const { replay } = run.options;
  if (advised === undefined && replay !== undefined) return await replayedAction(run, page, replay);
  const choice: { action: Action; elementKey?: string } =
    advised === undefined ? monkeyAction(run, page, snap) : { action: advised };
  const { action } = choice;
  const locator = isElementAction(action) ? await locatorOf(run, page, action.ref) : undefined;
  if (choice.elementKey !== undefined) run.exploration.recordAction(`${snap.url}#${snap.hash}`, choice.elementKey);
  const toLocator = action.type === "drag" ? await locatorOf(run, page, action.toRef) : undefined;
  return { action, source: advised === undefined ? "monkey" : "llm", locator, toLocator, targets: {} };
}

/** The durable locator of a ref, or undefined when it cannot be found in time. */
function locatorOf(run: ChoosingRun, page: Page, ref: string): Promise<string | undefined> {
  return bounded(durableLocator(page, ref), run.config.monkey.actionTimeoutMs, "durableLocator").catch(() => undefined);
}

function monkeyAction(run: ChoosingRun, page: Page, snap: Snapshot): { action: Action; elementKey?: string } {
  const { config, origin, scope } = run;
  const viewport = page.viewportSize() ?? {
    width: config.browser.viewport[0],
    height: config.browser.viewport[1],
  };
  return chooseAction(snap, run.exploration, run.random, {
    weights: config.monkey.weights,
    testData: config.testData,
    ...(origin === undefined ? {} : { origin }),
    ...(scope.restricted ? { scope } : {}),
    tabCount: run.context.pages().length,
    currentTab: run.tabs.current,
    viewport,
  });
}

async function replayedAction(run: ChoosingRun, page: Page, replay: ReplayPlan): Promise<Choice> {
  const planned = replay.actions[run.step] as PlannedAction;
  const { action, source, locator, toLocator } = planned;
  const targets = isElementAction(action) ? await findTargets(page, planned, run.config.monkey.actionTimeoutMs) : {};
  return { action, source, locator, toLocator, targets };
}

/** Replay: the recorded element of an action and, for `drag`, its drop target; or why one cannot be found. */
async function findTargets(page: Page, planned: PlannedAction, timeoutMs: number): Promise<Targets | string> {
  const element = await findElement(page, planned.locator, timeoutMs);
  if (typeof element === "string") return element;
  if (planned.action.type !== "drag") return { element };
  const to = await findElement(page, planned.toLocator, timeoutMs);
  return typeof to === "string" ? `drop target: ${to}` : { element, to };
}
