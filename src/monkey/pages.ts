import type { Page } from "playwright";
import type { Config } from "../config/config.ts";
import { type Snapshot, snapshot } from "../snapshot/snapshot.ts";
import type { Tabs } from "./executor.ts";

/** What the run loop's page handling needs: which page it acts in, and where it goes back to. */
export interface RunPages {
  readonly config: Config;
  readonly tabs: Tabs;
  /** Origin the run stays on, or undefined when `stayOnDomain` is off. */
  readonly origin: string | undefined;
  /** A crashed page throws on every call; it is closed and the run continues (the crash oracle reports it). */
  readonly crashed: WeakSet<Page>;
}

/** Opens `baseUrl` in the first page, unless that already shows a page. */
export async function openStartPage({ config, tabs }: RunPages): Promise<void> {
  const first = tabs.context.pages()[0] ?? (await tabs.context.newPage());
  if (first.url() === "about:blank") await first.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 });
}

/** The current page; a crashed one is closed and replaced by the first tab or a fresh page. */
export async function pageForStep({ config, tabs, crashed }: RunPages): Promise<Page | undefined> {
  const { context } = tabs;
  const page = context.pages()[tabs.current] ?? context.pages()[0];
  if (page === undefined || !crashed.has(page)) return page;
  await page.close().catch(() => undefined);
  tabs.current = 0;
  const fresh = context.pages()[0] ?? (await context.newPage());
  if (fresh.url() === "about:blank")
    await fresh.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
  return fresh;
}

/**
 * With `stayOnDomain`, brings a page that left the site back: the first tab goes to `baseUrl`, any other tab is
 * closed. True when the step must start over in the first tab.
 */
export async function leftSite({ config, tabs, origin }: RunPages, page: Page): Promise<boolean> {
  if (origin === undefined || isOn(page.url(), origin)) return false;
  if (tabs.current > 0) {
    // A popup that left the site (or never reached it): close it and go on in the first tab.
    await page.close().catch(() => undefined);
    tabs.current = 0;
    return true;
  }
  await page.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
  return false;
}

/** The page's snapshot, or undefined when the page crashed or closed while being read and the step starts over. */
export async function readPage({ tabs, crashed }: RunPages, page: Page): Promise<Snapshot | undefined> {
  try {
    return await snapshot(page);
  } catch (error) {
    // The page crashed while being read: start over on a fresh one.
    if (crashed.has(page)) return undefined;
    // It closed itself (`window.close()` in a popup) while being read: go on in another tab. Without any page
    // left, the next round ends the run.
    if (page.isClosed()) {
      tabs.current = 0;
      return undefined;
    }
    throw error;
  }
}

/**
 * Keeps at most `maxTabs` pages open: closes the oldest ones other than the first and the current, which the monkey
 * left behind (popups pile up quickly). Keeps `tabs.current` on the same page.
 */
export async function closeExtraTabs(tabs: Tabs, maxTabs: number): Promise<void> {
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
