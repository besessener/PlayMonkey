import { type Browser, chromium, firefox, webkit } from "playwright";
import type { Config } from "../config/config.ts";

const ENGINES = { chromium, firefox, webkit };

export interface LaunchOptions {
  /** Use this browser binary instead of the one installed for Playwright. */
  executablePath?: string;
}

/**
 * Launches the configured engine. One browser serves all roles; each role gets its own context. For Chromium,
 * `CHROMIUM_EXECUTABLE_PATH` selects another binary when the one installed for Playwright is not available.
 */
export function launchBrowser(browser: Config["browser"], options: LaunchOptions = {}): Promise<Browser> {
  const executablePath =
    options.executablePath ?? (browser.engine === "chromium" ? process.env.CHROMIUM_EXECUTABLE_PATH : undefined);
  return ENGINES[browser.engine].launch({
    headless: browser.headless,
    ...(executablePath === undefined || executablePath === "" ? {} : { executablePath }),
  });
}
