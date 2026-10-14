import type { Page } from "playwright";
import type { Secrets } from "../config/secrets.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import { isLoginPage } from "./login-page.ts";
import type { SessionEvent } from "./session.ts";

/** Failed re-logins in a row after which a run stops trying and goes on logged out. */
export const MAX_FAILED_RELOGINS = 3;

export interface KeeperOptions {
  /** `RoleSession.relogin` of the role. */
  relogin: () => Promise<void>;
  /** The session's events; a `session-lost` event is added to them. */
  events: SessionEvent[];
  secrets: Secrets;
  baseUrl: string;
  /** Absolute login page URL of a form-login role. */
  loginUrl?: string;
  /** Timeout of the navigation back to `baseUrl` after a re-login. */
  navigationTimeoutMs: number;
  log: (line: string) => void;
}

/**
 * Keeps an authenticated role logged in. Fed with every step's snapshot: when the role lands on a login page, it
 * records a `session-lost` event, logs in again and opens `baseUrl`. A re-login failed when it throws or the next
 * step is still on a login page; after `MAX_FAILED_RELOGINS` of them in a row the keeper gives up.
 */
export class SessionKeeper {
  readonly #options: KeeperOptions;
  #onLoginPage = false;
  /** The previous check logged in again; the next snapshot shows whether that helped. */
  #pending = false;
  #failures = 0;
  #gaveUp = false;

  constructor(options: KeeperOptions) {
    this.#options = options;
  }

  /** Checks the snapshot a step was taken in, and logs in again in `page` when it shows a login page. */
  async check(snapshot: Snapshot, page: Page | undefined): Promise<void> {
    const onLoginPage = isLoginPage(snapshot, this.#options.loginUrl);
    if (this.#pending) this.#failures = onLoginPage ? this.#failures + 1 : 0;
    this.#pending = false;
    const arrived = onLoginPage && !this.#onLoginPage;
    this.#onLoginPage = onLoginPage;
    if (!onLoginPage) return;
    const url = this.#options.secrets.mask(snapshot.url);
    if (arrived) {
      this.#options.events.push({ kind: "session-lost", url, time: new Date().toISOString() });
      this.#options.log(`warning: session lost, ${url} is a login page`);
    }
    if (this.#gaveUp) return;
    if (this.#failures >= MAX_FAILED_RELOGINS) {
      this.#gaveUp = true;
      this.#options.log(
        `not logging in again after ${MAX_FAILED_RELOGINS} failed attempts; the run goes on logged out`,
      );
      return;
    }
    await this.#relogin(page);
  }

  async #relogin(page: Page | undefined): Promise<void> {
    const { relogin, secrets, baseUrl, navigationTimeoutMs, log } = this.#options;
    try {
      await relogin();
    } catch (error) {
      this.#failures++;
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      log(secrets.mask(`logging in again failed: ${reason}`));
      return;
    }
    this.#pending = true;
    log("logged in again");
    // A page that does not load now is the next step's problem, as after any other action.
    await page?.goto(baseUrl, { timeout: navigationTimeoutMs }).catch(() => undefined);
  }
}

/** The number of `session-lost` events. */
export function sessionLosses(events: SessionEvent[]): number {
  return events.filter((event) => event.kind === "session-lost").length;
}
