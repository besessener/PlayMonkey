import { type Browser, chromium } from "playwright";

/**
 * Launches Chromium for tests. Set CHROMIUM_EXECUTABLE_PATH to use a preinstalled browser whose revision differs
 * from the one bundled with the installed Playwright version (e.g. in sandboxes that cannot run `playwright install`).
 */
export function launchChromium(): Promise<Browser> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  return chromium.launch(executablePath ? { executablePath } : {});
}
