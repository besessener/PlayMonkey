import type { RawHandoff } from "../config/schema.ts";
import type { StepRecord } from "../monkey/loop.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";

export const STUCK_TRIGGERS = [
  "noStateChange",
  "noProgress",
  "blockingUi",
  "failedActions",
  "invalidForm",
  "loginWall",
] as const;
export type StuckTrigger = (typeof STUCK_TRIGGERS)[number];

export interface Stuck {
  trigger: StuckTrigger;
  /** For the prompt, e.g. `a dialog is open: "Newsletter"`. */
  detail: string;
}

/** Text that suggests a cookie or consent banner, when a button to answer it is present too. */
const CONSENT_TEXT = /\b(cookies?|consent|tracking|datenschutz|privacy (settings|preferences))\b/i;
const CONSENT_BUTTON = /\b(accept|agree|allow|got it|ok|reject|decline|akzeptieren|zustimmen|erlauben|ablehnen)\b/i;
/** Text a form shows when it rejects its input. */
const VALIDATION_TEXT =
  /\b(invalid|required|is not valid|must (be|contain|not)|please (enter|provide|fill|select|choose)|ungültig|erforderlich|pflichtfeld|bitte (geben|füllen|wählen))\b/i;
const PASSWORD_FIELD = /\b(password|passwort|kennwort|passphrase)\b/i;
const LOGIN_BUTTON = /\b(log ?in|sign ?in|anmelden|einloggen)\b/i;

export interface StuckOptions {
  /** The role logged in at the start (form login or storageState). */
  authenticated: boolean;
  /** Absolute login page URL of a form-login role. */
  loginUrl?: string;
}

/**
 * Decides when the random monkey is stuck and the LLM should take over. Fed with every snapshot (`observe`) and
 * every executed step (`record`); `check` reports the first trigger that holds. Thresholds come from `llm.handoff`.
 */
export class StuckDetector {
  readonly #limits: RawHandoff;
  readonly #options: StuckOptions;
  #lastState: string | undefined;
  #sameState = 0;
  #sinceNewState = 0;
  #failedActions = 0;
  #invalidForms = 0;
  /** The previous step clicked a button or pressed Enter on this page path: a form may have been submitted. */
  #submittedOn: string | undefined;
  #onLoginPage = false;
  #loginWall = false;

  constructor(limits: RawHandoff, options: StuckOptions) {
    this.#limits = limits;
    this.#options = options;
  }

  /** A new snapshot was taken; `isNew` when its (URL, hash) state was never seen before in this run. */
  observe(snapshot: Snapshot, isNew: boolean): void {
    const state = `${snapshot.url}#${snapshot.hash}`;
    this.#sameState = state === this.#lastState ? this.#sameState + 1 : 0;
    this.#lastState = state;
    this.#sinceNewState = isNew ? 0 : this.#sinceNewState + 1;

    if (this.#submittedOn !== undefined) {
      const rejected = pathOf(snapshot.url) === this.#submittedOn && showsValidationErrors(snapshot);
      this.#invalidForms = rejected ? this.#invalidForms + 1 : 0;
      this.#submittedOn = undefined;
    }

    // Edge-triggered: fires when the role arrives on a login page, not on every step it stays there.
    const onLoginPage = this.#options.authenticated && this.#isLoginPage(snapshot);
    this.#loginWall = onLoginPage && !this.#onLoginPage;
    this.#onLoginPage = onLoginPage;
  }

  /** A step was executed in the state of `snapshot`. */
  record(record: StepRecord, snapshot: Snapshot): void {
    if (record.source === "monkey") this.#failedActions = record.result.ok ? 0 : this.#failedActions + 1;
    const { action } = record;
    const target = "ref" in action ? snapshot.elements.find((element) => element.ref === action.ref) : undefined;
    const submits =
      (action.type === "click" && target?.role === "button") || (action.type === "press" && action.key === "Enter");
    if (submits && hasForm(snapshot)) this.#submittedOn = pathOf(snapshot.url);
  }

  /** The reason to hand over now, or undefined. Checked before every monkey decision. */
  check(snapshot: Snapshot): Stuck | undefined {
    const limits = this.#limits;
    if (limits.blockingUi) {
      const blocking = blockingUi(snapshot);
      if (blocking !== undefined) return { trigger: "blockingUi", detail: blocking };
    }
    if (limits.loginWall && this.#loginWall) {
      return {
        trigger: "loginWall",
        detail: "the page looks like a login page although the role is logged in; the session may have expired",
      };
    }
    if (this.#invalidForms >= limits.invalidForm) {
      return {
        trigger: "invalidForm",
        detail: `a form rejected its input ${this.#invalidForms} times in a row; it needs valid data`,
      };
    }
    if (this.#failedActions >= limits.failedActions) {
      return { trigger: "failedActions", detail: `the last ${this.#failedActions} actions all failed` };
    }
    if (this.#sameState >= limits.noStateChange) {
      return { trigger: "noStateChange", detail: `the page did not change for ${this.#sameState} steps` };
    }
    if (this.#sinceNewState >= limits.noProgress) {
      return { trigger: "noProgress", detail: `no new page or state for ${this.#sinceNewState} steps` };
    }
    return undefined;
  }

  /** Starts counting afresh, after the LLM had its turn. */
  reset(): void {
    this.#sameState = 0;
    this.#sinceNewState = 0;
    this.#failedActions = 0;
    this.#invalidForms = 0;
    this.#loginWall = false;
  }

  #isLoginPage(snapshot: Snapshot): boolean {
    const { loginUrl } = this.#options;
    if (loginUrl !== undefined && pathOf(snapshot.url) === pathOf(loginUrl)) return true;
    const password = snapshot.elements.some((e) => e.role === "textbox" && PASSWORD_FIELD.test(e.name));
    const button = snapshot.elements.some(
      (e) => (e.role === "button" || e.role === "link") && LOGIN_BUTTON.test(e.name),
    );
    return password && button;
  }
}

/** Why the page is blocked, or undefined: an open dialog, or a cookie or consent banner. */
export function blockingUi(snapshot: Snapshot): string | undefined {
  if (snapshot.dialogs.length > 0) {
    const name = snapshot.dialogs[0] as string;
    return name === "" ? "a dialog is open" : `a dialog is open: ${JSON.stringify(name)}`;
  }
  if (
    CONSENT_TEXT.test(snapshot.text) &&
    snapshot.elements.some((element) => element.role === "button" && CONSENT_BUTTON.test(element.name))
  ) {
    return "a cookie or consent banner seems to be showing";
  }
  return undefined;
}

export function showsValidationErrors(snapshot: Snapshot): boolean {
  return hasForm(snapshot) && VALIDATION_TEXT.test(snapshot.text);
}

function hasForm(snapshot: Snapshot): boolean {
  return snapshot.elements.some((element) => element.role === "textbox" || element.role === "combobox");
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
