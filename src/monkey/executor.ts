import { type BrowserContext, errors, type Locator, type Page } from "playwright";
import { resolve } from "../snapshot/snapshot.ts";
import type { Action } from "./actions.ts";

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

/**
 * Executes one action with a timeout and waits for the page to settle: if the main document changed, until it has
 * loaded. Never throws for problems of the page under test; they come back as `{ ok: false, error }`. Element
 * actions act on `target` when given (replay), else on the element their ref points to.
 */
export async function executeAction(
  tabs: Tabs,
  action: Action,
  timeoutMs: number,
  target?: Locator,
): Promise<ActionResult> {
  let tab = tabs.current;
  let page = currentPage(tabs.context, tab);
  let navigated = false;
  // True while waiting for a navigation or load, where a timeout means the page hangs.
  let loading = false;
  const onNavigated = (frame: { parentFrame(): unknown }) => {
    if (frame.parentFrame() === null) navigated = true;
  };
  page.on("framenavigated", onNavigated);
  const element = async (ref: string) => target ?? (await resolve(page, ref));
  try {
    switch (action.type) {
      case "click":
        await (await element(action.ref)).click({ timeout: timeoutMs });
        break;
      case "fill":
        await (await element(action.ref)).fill(action.value, { timeout: timeoutMs });
        break;
      case "select":
        await (await element(action.ref)).selectOption({ label: action.value }, { timeout: timeoutMs });
        break;
      case "check":
      case "uncheck":
        await (await element(action.ref)).setChecked(action.type === "check", { timeout: timeoutMs });
        break;
      case "press":
        await page.keyboard.press(action.key);
        break;
      case "scroll":
        await page.mouse.wheel(0, action.deltaY);
        break;
      case "back":
        loading = true;
        await page.goBack({ timeout: timeoutMs });
        break;
      case "navigate":
        loading = true;
        await page.goto(action.url, { timeout: timeoutMs });
        break;
      case "setViewport":
        await page.setViewportSize({ width: action.width, height: action.height });
        break;
      case "switchTab":
        tab = action.index;
        page.off("framenavigated", onNavigated);
        page = currentPage(tabs.context, tab);
        await page.bringToFront();
        break;
    }
    if (navigated) {
      loading = true;
      await page.waitForLoadState("load", { timeout: timeoutMs });
    }
    return { ok: true, navigated, url: page.url(), tab };
  } catch (error) {
    const hang = loading && error instanceof errors.TimeoutError;
    return { ok: false, error: firstLine(error), ...(hang ? { hang } : {}), navigated, url: safeUrl(page), tab };
  } finally {
    page.off("framenavigated", onNavigated);
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
