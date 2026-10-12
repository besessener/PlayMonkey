import type { BrowserContext, Page } from "playwright";
import { resolve } from "../snapshot/snapshot.ts";
import type { Action } from "./actions.ts";

export interface ActionResult {
  ok: boolean;
  /** Why the action failed; a failed action is not a finding. */
  error?: string;
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
 * loaded. Never throws for problems of the page under test; they come back as `{ ok: false, error }`.
 */
export async function executeAction(tabs: Tabs, action: Action, timeoutMs: number): Promise<ActionResult> {
  let tab = tabs.current;
  let page = currentPage(tabs.context, tab);
  let navigated = false;
  const onNavigated = (frame: { parentFrame(): unknown }) => {
    if (frame.parentFrame() === null) navigated = true;
  };
  page.on("framenavigated", onNavigated);
  try {
    switch (action.type) {
      case "click":
        await (await resolve(page, action.ref)).click({ timeout: timeoutMs });
        break;
      case "fill":
        await (await resolve(page, action.ref)).fill(action.value, { timeout: timeoutMs });
        break;
      case "select":
        await (await resolve(page, action.ref)).selectOption({ label: action.value }, { timeout: timeoutMs });
        break;
      case "check":
      case "uncheck":
        await (await resolve(page, action.ref)).setChecked(action.type === "check", { timeout: timeoutMs });
        break;
      case "press":
        await page.keyboard.press(action.key);
        break;
      case "scroll":
        await page.mouse.wheel(0, action.deltaY);
        break;
      case "back":
        await page.goBack({ timeout: timeoutMs });
        break;
      case "navigate":
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
    if (navigated) await page.waitForLoadState("load", { timeout: timeoutMs });
    return { ok: true, navigated, url: page.url(), tab };
  } catch (error) {
    return { ok: false, error: firstLine(error), navigated, url: safeUrl(page), tab };
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
