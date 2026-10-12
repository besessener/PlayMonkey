import type { Browser } from "playwright";
import { launchBrowser } from "../../src/auth/browser.ts";

/** Launches headless Chromium; `CHROMIUM_EXECUTABLE_PATH` selects another binary (see launchBrowser). */
export function launchChromium(): Promise<Browser> {
  return launchBrowser({ engine: "chromium", viewport: [1280, 800], headless: true });
}
