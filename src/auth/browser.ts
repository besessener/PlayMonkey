import { type Browser, chromium, firefox, webkit } from "playwright";
import type { Config } from "../config/config.ts";
import type { Spectator } from "../monkey/spectator.ts";

const ENGINES = { chromium, firefox, webkit };

export interface LaunchOptions {
  /** Use this browser binary instead of the one installed for Playwright. */
  executablePath?: string;
  /** Spectator mode: a visible, slowed-down browser, whatever `browser.headless` says. */
  spectator?: Spectator;
}

/**
 * Launches the configured engine. One browser serves all roles; each role gets its own context. For Chromium,
 * `CHROMIUM_EXECUTABLE_PATH` selects another binary when the one installed for Playwright is not available. The
 * caller closes the browser, also after a stop signal (see `withStopSignal`).
 */
export function launchBrowser(browser: Config["browser"], options: LaunchOptions = {}): Promise<Browser> {
  const executablePath =
    options.executablePath ?? (browser.engine === "chromium" ? process.env.CHROMIUM_EXECUTABLE_PATH : undefined);
  const { spectator } = options;
  return ENGINES[browser.engine].launch({
    headless: spectator === undefined ? browser.headless : false,
    // Playwright's handlers would close the browser and exit before the run stops and writes its report.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...(spectator === undefined || spectator.slowMoMs === 0 ? {} : { slowMo: spectator.slowMoMs }),
    ...(executablePath === undefined || executablePath === "" ? {} : { executablePath }),
  });
}
