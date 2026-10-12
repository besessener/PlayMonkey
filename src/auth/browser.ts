import { type Browser, chromium, firefox, webkit } from "playwright";
import type { Config } from "../config/config.ts";

const ENGINES = { chromium, firefox, webkit };

export interface LaunchOptions {
  /** Use this browser binary instead of the one installed for Playwright. */
  executablePath?: string;
}

/** Launches the configured engine. One browser serves all roles; each role gets its own context. */
export function launchBrowser(browser: Config["browser"], options: LaunchOptions = {}): Promise<Browser> {
  return ENGINES[browser.engine].launch({
    headless: browser.headless,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  });
}
