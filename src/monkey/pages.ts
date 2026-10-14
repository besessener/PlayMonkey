import type { Page } from "playwright";
import type { Config } from "../config/config.ts";
import { type Snapshot, snapshot } from "../snapshot/snapshot.ts";
import { installPopupProbe, type Tabs } from "./executor.ts";
import type { UrlScope } from "./scope.ts";
import { bounded, isUnresponsive, withTimeout } from "./timeout.ts";

/** What the run loop's page handling needs: which page it acts in, and where it goes back to. */
export interface RunPages {
  readonly config: Config;
  readonly tabs: Tabs;
  /** Origin the run stays on, or undefined when `stayOnDomain` is off. */
  readonly origin: string | undefined;
  /** URLs the run may be on. */
  readonly scope: UrlScope;
  /**
   * Pages that crashed (they throw on every call) or stopped responding (their calls never settle); they are closed and
   * the run continues. The `crash` and `hang` oracles report them.
   */
  readonly unusable: WeakSet<Page>;
}

/** Installs the popup probe, then opens `baseUrl` in the first page unless that already shows a page. */
export async function openStartPage({ config, tabs }: RunPages): Promise<void> {
  await installPopupProbe(tabs.context);
  const first = tabs.context.pages()[0] ?? (await tabs.context.newPage());
  if (first.url() === "about:blank") await first.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 });
}

/** The current page; an unusable one is closed and replaced by the first tab or a fresh page. */
export async function pageForStep({ config, tabs, unusable }: RunPages): Promise<Page | undefined> {
  const { context } = tabs;
  const page = context.pages()[tabs.current] ?? context.pages()[0];
  if (page === undefined || !unusable.has(page)) return page;
  await closePage(page, config.monkey.actionTimeoutMs);
  tabs.current = 0;
  const fresh = context.pages()[0] ?? (await context.newPage());
  if (fresh.url() === "about:blank")
    await fresh.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
  return fresh;
}

/**
 * Brings a page that left the site (`stayOnDomain`) or the `scope` back: the first tab goes to `baseUrl`, any other
 * tab is closed. True when the step must start over in the first tab. The navigation guard blocks most of these;
 * redirects and client-side navigations get past it.
 */
export async function leftSite({ config, tabs, origin, scope }: RunPages, page: Page): Promise<boolean> {
  const url = page.url();
  const outOfScope = scope.restricted && /^https?:/.test(url) && !scope.allows(url);
  if (!outOfScope && (origin === undefined || isOn(url, origin))) return false;
  if (tabs.current > 0) {
    // A popup that left the site (or never reached it): close it and go on in the first tab.
    await closePage(page, config.monkey.actionTimeoutMs);
    tabs.current = 0;
    return true;
  }
  await page.goto(config.baseUrl, { timeout: config.monkey.actionTimeoutMs * 4 }).catch(() => undefined);
  return false;
}

/**
 * The page's snapshot, or undefined when the page crashed, stopped responding or closed while being read and the step
 * starts over.
 */
export async function readPage({ config, tabs, unusable }: RunPages, page: Page): Promise<Snapshot | undefined> {
  const timeoutMs = config.monkey.actionTimeoutMs;
  try {
    // Iframes are entered one by one, so the whole snapshot gets more time than its aria part.
    return await bounded(snapshot(page, timeoutMs), timeoutMs * 4, "snapshot");
  } catch (error) {
    // The page crashed or froze while being read: start over on a fresh one.
    if (isUnresponsive(error)) unusable.add(page);
    if (unusable.has(page)) return undefined;
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
export async function closeExtraTabs(
  tabs: Tabs,
  { maxTabs, actionTimeoutMs }: RunPages["config"]["monkey"],
): Promise<void> {
  const pages = tabs.context.pages();
  if (pages.length <= maxTabs) return;
  const current = pages[tabs.current];
  const closable = pages.filter((page, index) => index > 0 && page !== current);
  for (const page of closable.slice(0, pages.length - maxTabs)) await closePage(page, actionTimeoutMs);
  tabs.current = Math.max(0, current === undefined ? 0 : tabs.context.pages().indexOf(current));
}

/** Closes a page, also a frozen one, without waiting longer than `timeoutMs` and without throwing. */
async function closePage(page: Page, timeoutMs: number): Promise<void> {
  await withTimeout(page.close(), timeoutMs).catch(() => undefined);
}

function isOn(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
