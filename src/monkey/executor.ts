import { type BrowserContext, errors, type Locator, type Page } from "playwright";
import { parseLocator } from "../replay/locator.ts";
import { resolve } from "../snapshot/snapshot.ts";
import { type Action, type ElementAction, isElementAction } from "./actions.ts";
import { HIGHLIGHT_STYLE, type Spectator } from "./spectator.ts";

export interface ActionResult {
  ok: boolean;
  /** Why the action failed; a failed action is not a finding. */
  error?: string;
  /**
   * A navigation or page load exceeded the timeout, as opposed to an element that never became actionable. Only set
   * on failed actions; the `hang` oracle reports it.
   */
  hang?: boolean;
  /** The top-level document changed (navigation or reload). */
  navigated: boolean;
  url: string;
  /** Index of the tab the monkey continues in. */
  tab: number;
}

export interface Tabs {
  context: BrowserContext;
  /** Index into `context.pages()`. */
  current: number;
}

/** Replay: the recorded elements, found by their durable locators, instead of the action's refs. */
export interface Targets {
  element?: Locator;
  /** The drop target of a `drag`. */
  to?: Locator;
}

/** How long a long press holds the mouse button. */
export const LONG_PRESS_MS = 800;

/**
 * How long a click-like action waits for a popup it may have opened. The browser reports a new page a few
 * milliseconds after the click itself has returned.
 */
const POPUP_GRACE_MS = 50;
const CLICK_LIKE = new Set<Action["type"]>(["click", "dblclick", "longPress", "press"]);

export interface ExecuteOptions {
  /** Replay: act on these instead of the elements the action's refs point to. */
  targets?: Targets;
  /** Outline the element first; `locator` (its durable locator) only makes the outline's label readable. */
  spectator?: Spectator & { locator?: string };
}

/** What an element or page action needs; `state.loading` is set while waiting for a navigation or load. */
interface ActionContext {
  page: Page;
  timeoutMs: number;
  targets: Targets;
  spectator: (Spectator & { locator?: string }) | undefined;
  state: { loading: boolean };
}

type PageAction = Exclude<Action, ElementAction | { type: "switchTab" }>;

/**
 * Executes one action with a timeout and waits for the page to settle: if the main document changed, until it has
 * loaded. Never throws for problems of the page under test; they come back as `{ ok: false, error }`. Element
 * actions act on `options.targets` when given (replay), else on the element their ref points to. With a
 * `spectator`, the element is outlined for a moment first.
 *
 * When the action opens a popup or new tab, the monkey continues there, like a user would: the result's `tab` is
 * the new page once it has loaded its document.
 */
export async function executeAction(
  tabs: Tabs,
  action: Action,
  timeoutMs: number,
  options: ExecuteOptions = {},
): Promise<ActionResult> {
  let tab = tabs.current;
  let page = currentPage(tabs.context, tab);
  const opened: Page[] = [];
  const onPage = (popup: Page) => opened.push(popup);
  tabs.context.on("page", onPage);
  let navigated = false;
  // True while waiting for a navigation or load, where a timeout means the page hangs.
  const state = { loading: false };
  const onNavigated = (frame: { parentFrame(): unknown }) => {
    if (frame.parentFrame() === null) navigated = true;
  };
  page.on("framenavigated", onNavigated);
  try {
    if (action.type === "switchTab") {
      tab = action.index;
      page.off("framenavigated", onNavigated);
      page = currentPage(tabs.context, tab);
      await page.bringToFront();
    } else {
      const context = { page, timeoutMs, targets: options.targets ?? {}, spectator: options.spectator, state };
      if (isElementAction(action)) await actOnElement(context, action);
      else await actOnPage(context, action);
    }
    if (navigated) {
      state.loading = true;
      await page.waitForLoadState("load", { timeout: timeoutMs });
    }
    if (CLICK_LIKE.has(action.type)) await settle(page, tabs.context, opened);
    return (await popupResult(tabs.context, opened, timeoutMs)) ?? { ok: true, navigated, url: page.url(), tab };
  } catch (error) {
    const hang = state.loading && error instanceof errors.TimeoutError;
    return { ok: false, error: firstLine(error), ...(hang ? { hang } : {}), navigated, url: safeUrl(page), tab };
  } finally {
    page.off("framenavigated", onNavigated);
    tabs.context.off("page", onPage);
  }
}

/** The action's element: the replay target when given, else the one its ref points to; outlined first. */
async function element(context: ActionContext, ref: string): Promise<Locator> {
  const { page, spectator } = context;
  const locator = context.targets.element ?? (await resolve(page, ref));
  if (spectator !== undefined && spectator.highlightMs > 0) {
    await show(page, readable(page, spectator.locator) ?? locator, spectator.highlightMs);
  }
  return locator;
}

async function actOnElement(context: ActionContext, action: ElementAction): Promise<void> {
  const { page, timeoutMs } = context;
  switch (action.type) {
    case "click":
      await (await element(context, action.ref)).click({ timeout: timeoutMs });
      break;
    case "dblclick":
      await (await element(context, action.ref)).dblclick({ timeout: timeoutMs });
      break;
    case "rightclick":
      await (await element(context, action.ref)).click({ button: "right", timeout: timeoutMs });
      break;
    case "hover":
      await (await element(context, action.ref)).hover({ timeout: timeoutMs });
      break;
    case "longPress":
      // Touch-style long press with the mouse: down, hold, up.
      await (await element(context, action.ref)).hover({ timeout: timeoutMs });
      await page.mouse.down();
      await delay(LONG_PRESS_MS);
      await page.mouse.up();
      break;
    case "drag": {
      const source = await element(context, action.ref);
      const target = context.targets.to ?? (await resolve(page, action.toRef));
      await source.dragTo(target, { timeout: timeoutMs });
      break;
    }
    case "fill":
      await (await element(context, action.ref)).fill(action.value, { timeout: timeoutMs });
      break;
    case "select":
      await (await element(context, action.ref)).selectOption({ label: action.value }, { timeout: timeoutMs });
      break;
    default:
      // check or uncheck
      await (await element(context, action.ref)).setChecked(action.type === "check", { timeout: timeoutMs });
  }
}

async function actOnPage({ page, timeoutMs, state }: ActionContext, action: PageAction): Promise<void> {
  switch (action.type) {
    case "press":
      await page.keyboard.press(action.key);
      break;
    case "scroll":
      await page.mouse.wheel(0, action.deltaY);
      break;
    case "back":
      state.loading = true;
      await page.goBack({ timeout: timeoutMs });
      break;
    case "navigate":
      state.loading = true;
      await page.goto(action.url, { timeout: timeoutMs });
      break;
    default:
      // setViewport
      await page.setViewportSize({ width: action.width, height: action.height });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, ms));
}

/**
 * Lets events the action caused arrive: one round trip to the page (file choosers and dialogs come before its
 * answer), then up to `POPUP_GRACE_MS` for a new page, unless one has opened already.
 */
async function settle(page: Page, context: BrowserContext, opened: Page[]): Promise<void> {
  await page.evaluate("0").catch(() => undefined);
  if (opened.length > 0) return;
  await context.waitForEvent("page", { timeout: POPUP_GRACE_MS }).catch(() => undefined);
}

/** The result of continuing in the last popup the action opened, if one is still open. */
async function popupResult(
  context: BrowserContext,
  opened: Page[],
  timeoutMs: number,
): Promise<ActionResult | undefined> {
  const popup = await openedPopup(opened, timeoutMs);
  if (popup === undefined) return undefined;
  const index = context.pages().indexOf(popup);
  return index >= 0 ? { ok: true, navigated: true, url: popup.url(), tab: index } : undefined;
}

/** The last page the action opened that is still open, once its document has loaded. */
async function openedPopup(opened: Page[], timeoutMs: number): Promise<Page | undefined> {
  for (const popup of opened.toReversed()) {
    if (popup.isClosed()) continue;
    await popup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
    if (!popup.isClosed()) return popup;
  }
  return undefined;
}

/** Outlines the element, waits, and removes the outline again so the next snapshot never contains it. */
async function show(page: Page, locator: Locator, ms: number): Promise<void> {
  try {
    await locator.highlight({ style: HIGHLIGHT_STYLE });
    await delay(ms);
  } catch {
    // Only cosmetic: the action itself reports a missing element.
  } finally {
    await page.hideHighlight().catch(() => undefined);
  }
}

function readable(page: Page, text: string | undefined): Locator | undefined {
  try {
    return text === undefined ? undefined : parseLocator(page, text);
  } catch {
    return undefined;
  }
}

function currentPage(context: BrowserContext, index: number): Page {
  const pages = context.pages();
  const page = pages[index] ?? pages[0];
  if (page === undefined) throw new Error("the browser context has no open page");
  return page;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown error";
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
