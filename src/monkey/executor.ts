import { type BrowserContext, errors, type Locator, type Page } from "playwright";
import { parseLocator } from "../replay/locator.ts";
import { resolve } from "../snapshot/snapshot.ts";
import { type Action, type ElementAction, isElementAction } from "./actions.ts";
import { NavigationWatch } from "./navigation.ts";
import { HIGHLIGHT_STYLE, type Spectator } from "./spectator.ts";
import { bounded, TIMEOUT, withTimeout } from "./timeout.ts";

export interface ActionResult {
  ok: boolean;
  /** Why the action failed; a failed action is not a finding. */
  error?: string;
  /**
   * The URL of a navigation or page load that exceeded the timeout, as opposed to an element that never became
   * actionable. Only set on failed actions; the `hang` oracle reports it.
   */
  hang?: string;
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
 * How long a click-like action waits for a popup when the page did not say it asked for one (see `POPUP_PROBE`). The
 * browser reports a new page some milliseconds after the click itself has returned.
 */
const POPUP_GRACE_MS = 50;

/**
 * Counts the popups a page asks for, in `__monkeyPopups`: `window.open` calls that returned a window, and clicks on
 * links with a target other than the page itself that no handler prevented. With it, a click that opens a tab waits
 * for that tab however long the browser takes, instead of a fixed grace that a busy machine can miss. Installed by
 * `installPopupProbe`; idempotent.
 */
const POPUP_PROBE = `(() => {
  if ("__monkeyPopups" in globalThis) return;
  let count = 0;
  Object.defineProperty(globalThis, "__monkeyPopups", { get: () => count });
  const open = globalThis.open;
  if (typeof open === "function") {
    globalThis.open = function (...args) {
      const opened = open.apply(this, args);
      if (opened) count++;
      return opened;
    };
  }
  globalThis.addEventListener("click", (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const link = event.target.closest("a[href], area[href]");
    const target = (link?.getAttribute("target") ?? "").toLowerCase();
    if (target !== "" && !["_self", "_parent", "_top"].includes(target)) count++;
  });
})();`;

/** Makes every page of the context, also later ones, report the popups it asks for (`POPUP_PROBE`). */
export async function installPopupProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: POPUP_PROBE });
  for (const page of context.pages()) await page.evaluate(POPUP_PROBE).catch(() => undefined);
}

/** The page's popup count, or 0 without the probe (or when it cannot be read in time). */
async function popupRequests(page: Page, timeoutMs: number): Promise<number> {
  const count = await withTimeout(page.evaluate("globalThis.__monkeyPopups ?? 0").then(Number), timeoutMs).catch(
    () => 0,
  );
  return count === TIMEOUT ? 0 : count;
}
const CLICK_LIKE = new Set<Action["type"]>(["click", "dblclick", "longPress", "press"]);

export interface ExecuteOptions {
  /** Replay: act on these instead of the elements the action's refs point to. */
  targets?: Targets;
  /** Outline the element first; `locator` (its durable locator) only makes the outline's label readable. */
  spectator?: Spectator & { locator?: string };
}

/** What an element or page action needs. */
interface ActionContext {
  page: Page;
  timeoutMs: number;
  targets: Targets;
  spectator: (Spectator & { locator?: string }) | undefined;
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
  const tab = action.type === "switchTab" ? action.index : tabs.current;
  const page = currentPage(tabs.context, tab);
  const opened: Page[] = [];
  const onPage = (popup: Page) => opened.push(popup);
  tabs.context.on("page", onPage);
  const watch = new NavigationWatch(page);
  try {
    const popupsBefore = CLICK_LIKE.has(action.type) ? await popupRequests(page, timeoutMs) : 0;
    await act({ page, timeoutMs, targets: options.targets ?? {}, spectator: options.spectator }, action);
    if (watch.navigated) await page.waitForLoadState("load", { timeout: timeoutMs });
    if (CLICK_LIKE.has(action.type)) await settle(page, { context: tabs.context, opened, popupsBefore, timeoutMs });
    const { navigated } = watch;
    return (await popupResult(tabs.context, opened, timeoutMs)) ?? { ok: true, navigated, url: page.url(), tab };
  } catch (error) {
    const hang = error instanceof errors.TimeoutError ? watch.loading : undefined;
    const result = { ok: false, error: firstLine(error), navigated: watch.navigated, url: safeUrl(page), tab };
    return hang === undefined ? result : { ...result, hang };
  } finally {
    watch.detach();
    tabs.context.off("page", onPage);
  }
}

async function act(context: ActionContext, action: Action): Promise<void> {
  if (action.type === "switchTab") await bounded(context.page.bringToFront(), context.timeoutMs, "page.bringToFront");
  else if (isElementAction(action)) await actOnElement(context, action);
  else await actOnPage(context, action);
}

/** The action's element: the replay target when given, else the one its ref points to; outlined first. */
async function element(context: ActionContext, ref: string): Promise<Locator> {
  const { page, spectator, timeoutMs } = context;
  const locator = context.targets.element ?? (await bounded(resolve(page, ref), timeoutMs, "locator.count"));
  if (spectator !== undefined && spectator.highlightMs > 0) {
    await show(page, readable(page, spectator.locator) ?? locator, { ms: spectator.highlightMs, timeoutMs });
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
      await bounded(page.mouse.down(), timeoutMs, "mouse.down");
      await delay(LONG_PRESS_MS);
      await bounded(page.mouse.up(), timeoutMs, "mouse.up");
      break;
    case "drag": {
      const source = await element(context, action.ref);
      const target = context.targets.to ?? (await bounded(resolve(page, action.toRef), timeoutMs, "locator.count"));
      await source.dragTo(target, { timeout: timeoutMs });
      break;
    }
    case "fill":
      await (await element(context, action.ref)).fill(action.value, { timeout: timeoutMs });
      break;
    case "select":
      await (await element(context, action.ref)).selectOption({ label: action.value }, { timeout: timeoutMs });
      break;
    case "check":
    case "uncheck":
      await (await element(context, action.ref)).setChecked(action.type === "check", { timeout: timeoutMs });
      break;
    default:
      unhandled(action);
  }
}

async function actOnPage({ page, timeoutMs }: ActionContext, action: PageAction): Promise<void> {
  switch (action.type) {
    case "press":
      await bounded(page.keyboard.press(action.key), timeoutMs, "keyboard.press");
      break;
    case "scroll":
      await bounded(page.mouse.wheel(0, action.deltaY), timeoutMs, "mouse.wheel");
      break;
    case "back":
      await page.goBack({ timeout: timeoutMs });
      break;
    case "navigate":
      await page.goto(action.url, { timeout: timeoutMs });
      break;
    case "setViewport":
      await bounded(page.setViewportSize({ width: action.width, height: action.height }), timeoutMs, "setViewportSize");
      break;
    case "offline":
      // The run loop goes back online after the next step.
      await page.context().setOffline(true);
      break;
    default:
      unhandled(action);
  }
}

// Biome cannot narrow Extract/Exclude unions, so the switches above end in a default that tsc proves unreachable.
function unhandled(action: never): never {
  throw new Error(`unhandled action ${JSON.stringify(action)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, ms));
}

interface SettleOptions {
  context: BrowserContext;
  /** Pages the action has opened so far. */
  opened: Page[];
  /** The page's popup count (`popupRequests`) before the action. */
  popupsBefore: number;
  timeoutMs: number;
}

/**
 * Lets events the action caused arrive: one round trip to the page (file choosers and dialogs come before its
 * answer), then, unless a new page has opened already, up to `timeoutMs` for it when the page asked for a popup,
 * else up to `POPUP_GRACE_MS`.
 */
async function settle(page: Page, { context, opened, popupsBefore, timeoutMs }: SettleOptions): Promise<void> {
  const requested = (await popupRequests(page, timeoutMs)) > popupsBefore;
  if (opened.length > 0) return;
  await context.waitForEvent("page", { timeout: requested ? timeoutMs : POPUP_GRACE_MS }).catch(() => undefined);
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
async function show(page: Page, locator: Locator, { ms, timeoutMs }: { ms: number; timeoutMs: number }): Promise<void> {
  try {
    await bounded(locator.highlight({ style: HIGHLIGHT_STYLE }), timeoutMs, "locator.highlight");
    await delay(ms);
  } catch {
    // Only cosmetic: the action itself reports a missing element.
  } finally {
    await withTimeout(page.hideHighlight(), timeoutMs).catch(() => undefined);
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
