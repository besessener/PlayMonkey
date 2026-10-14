import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from "playwright";
import type { Config } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";
import type { OracleName } from "../config/values.ts";
import type { StepRecord } from "../monkey/loop.ts";
import { TIMEOUT, withTimeout } from "../monkey/timeout.ts";
import { AccessibilityAudit } from "./accessibility.ts";
import { type ActionContext, type Finding, IgnoreRules, type Signal } from "./finding.ts";
import { firstStackFrame, normalizeMessage, normalizeUrl } from "./keys.ts";
import {
  ERROR_PAGE_PATTERNS,
  FAILED_RESOURCE,
  IGNORED_NAVIGATION_FAILURES,
  markSecretFields,
  OFFLINE_RESOURCE,
  type PageFacts,
  READ_PAGE_FACTS,
  SECRET_FIELD,
  UNMARK_SECRET_FIELDS,
} from "./patterns.ts";

export interface OracleOptions {
  config: Config;
  role: string;
  /** Directory for finding screenshots; created on the first finding. */
  screenshotDir: string;
  /**
   * Masks finding keys before deduplication, so the same bug keeps one key whatever secret it showed, and blacks out
   * fields holding a secret in screenshots. Password fields are blacked out without it too.
   */
  secrets?: Secrets;
}

/**
 * Watches every page of a context, popups and iframes included, and turns problems into deduplicated findings.
 * Event-based oracles (`pageerror`, `console`, `http4xx`, `http5xx`, `crash`) collect signals as they happen; `check`
 * runs after every step, adds the state-based ones (`hang`, `errorPage`, `overflow`) and failed downloads of the
 * step (`download`), and files all collected signals under that step.
 */
export class Oracles {
  readonly findings: Finding[] = [];
  readonly #config: Config;
  readonly #role: string;
  readonly #screenshotDir: string;
  readonly #secrets: Secrets | undefined;
  /** Secret values the monkey may type into fields; the LLM's API key is never sent to the page. */
  readonly #typedSecrets: string[];
  readonly #origin: string;
  readonly #ignore: IgnoreRules;
  readonly #byKey = new Map<string, Finding>();
  readonly #history: ActionContext[] = [];
  readonly #documentStatus = new WeakMap<Page, number>();
  readonly #crashed = new WeakSet<Page>();
  readonly #accessibility: AccessibilityAudit;
  /** Overflow seen by the previous check, to count a page that stays overflowing once. */
  #overflow: { page: Page; key: string } | undefined;
  #pending: Signal[] = [];
  #step = 0;
  #page: Page | undefined;

  constructor(context: BrowserContext, options: OracleOptions) {
    this.#config = options.config;
    this.#role = options.role;
    this.#screenshotDir = options.screenshotDir;
    this.#secrets = options.secrets;
    const apiKey = options.config.llm?.apiKey;
    this.#typedSecrets = (options.secrets?.entries ?? [])
      .map(({ value }) => value)
      .filter((value) => apiKey === undefined || !apiKey.includes(value));
    this.#origin = new URL(options.config.baseUrl).origin;
    this.#ignore = new IgnoreRules(options.config.findings.ignore);
    this.#accessibility = new AccessibilityAudit(this.#origin);
    for (const page of context.pages()) this.#watch(page);
    context.on("page", (page) => this.#watch(page));
  }

  /** Runs the state-based oracles on the page the step ended on and files every signal collected so far. */
  async check(record: StepRecord, page: Page | undefined): Promise<void> {
    this.#step = record.step;
    this.#page = page;
    const limit = this.#config.findings.lastActions;
    this.#history.push({
      step: record.step,
      action: record.action,
      ...(record.locator === undefined ? {} : { locator: record.locator }),
      ...(record.toLocator === undefined ? {} : { toLocator: record.toLocator }),
      url: record.url,
    });
    if (this.#history.length > limit) this.#history.splice(0, this.#history.length - limit);

    const { hang } = record.result;
    if (hang !== undefined) {
      this.#add("hang", {
        severity: "high",
        key: `navigation|${this.#url(hang)}`,
        message: `${hang} did not load within ${this.#config.monkey.actionTimeoutMs}ms: ${record.result.error ?? ""}`,
        url: hang,
        details: { kind: "navigation", action: record.action, error: record.result.error },
      });
    }
    for (const event of record.events ?? []) {
      if (event.kind !== "download" || event.failure === undefined) continue;
      const path = this.#url(event.url);
      this.#add("download", {
        severity: "medium",
        key: path,
        message: `download of ${event.name} from ${path} failed: ${event.failure}`,
        url: event.url,
        details: { name: event.name, url: event.url, failure: event.failure },
      });
    }
    // While a navigation is still loading, the page answers nothing, which says nothing about it.
    if (page !== undefined && hang === undefined && !this.#crashed.has(page) && /^https?:/.test(page.url())) {
      await this.#inspect(page, record.result.navigated);
      await this.#audit(page);
    }
    await this.#flush();
  }

  async #audit(page: Page): Promise<void> {
    if (!this.#config.oracles.accessibility) return;
    // axe needs longer than a click on large pages.
    const signals = await this.#accessibility.audit(page, this.#config.monkey.actionTimeoutMs * 4);
    for (const signal of signals) this.#add("accessibility", signal);
  }

  /** Files signals that arrived after the last step. Call once after the run. */
  async finish(): Promise<Finding[]> {
    await this.#flush();
    return this.findings;
  }

  #watch(page: Page): void {
    page.on("pageerror", (error) => {
      const message = `${error.name}: ${error.message}`;
      this.#add("pageerror", {
        severity: "high",
        key: `${this.#text(message)}|${firstStackFrame(this.#mask(error.stack ?? ""), this.#origin, this.#mask(message))}`,
        message,
        url: safeUrl(page),
        details: { stack: (error.stack ?? "").split("\n").slice(0, 10).join("\n") },
      });
    });
    page.on("console", (message) => this.#onConsole(page, message));
    page.on("response", (response) => this.#onResponse(page, response));
    page.on("requestfailed", (request) => this.#onRequestFailed(page, request));
    page.on("crash", () => {
      this.#crashed.add(page);
      this.#add("crash", {
        severity: "critical",
        key: this.#url(safeUrl(page)),
        message: `page crashed on ${safeUrl(page)}`,
        url: safeUrl(page),
        details: {},
      });
    });
  }

  #onConsole(page: Page, message: ConsoleMessage): void {
    if (message.type() !== "error") return;
    const text = message.text();
    if (FAILED_RESOURCE.test(text) || OFFLINE_RESOURCE.test(text)) return;
    const location = message.location();
    this.#add("console", {
      severity: "medium",
      key: this.#text(text),
      message: text,
      url: safeUrl(page),
      details: { location: `${location.url}:${location.line + 1}:${location.column + 1}` },
    });
  }

  #onResponse(page: Page, response: Response): void {
    const status = response.status();
    const request = response.request();
    let isDocument = false;
    try {
      isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      // Service worker requests have no frame.
    }
    if (isDocument) this.#documentStatus.set(page, status);
    if (status < 400 || this.#config.findings.ignoreStatus.includes(status)) return;

    const oracle = status >= 500 ? "http5xx" : "http4xx";
    const url = response.url();
    const method = request.method();
    const path = this.#url(url);
    this.#add(oracle, {
      severity: httpSeverity(status, isDocument),
      key: `${method} ${path} ${status}`,
      message: `${method} ${path} responded ${status}${response.statusText() === "" ? "" : ` ${response.statusText()}`}`,
      url,
      details: { method, url, status, statusText: response.statusText(), resourceType: request.resourceType() },
    });
  }

  /**
   * A top-level navigation that failed in the network (connection refused or reset, empty response): the browser
   * shows its own error page, which no other oracle sees. Aborted navigations are the guard's or a newer navigation's
   * doing, and requests made while offline fail on purpose.
   */
  #onRequestFailed(page: Page, request: Request): void {
    const failure = request.failure()?.errorText ?? "";
    if (IGNORED_NAVIGATION_FAILURES.has(failure) || !isMainFrameNavigation(page, request)) return;
    const url = request.url();
    const path = this.#url(url);
    this.#add("errorPage", {
      severity: "high",
      key: `${path}|${failure}`,
      message: `navigation to ${path} failed: ${failure}`,
      url,
      details: { url, failure },
    });
  }

  /** True when an HTTP oracle reports this status, or it is ignored on purpose; then errorPage does not repeat it. */
  #httpCovers(status: number): boolean {
    if (this.#config.findings.ignoreStatus.includes(status)) return true;
    return this.#config.oracles[status >= 500 ? "http5xx" : "http4xx"];
  }

  async #inspect(page: Page, navigated: boolean): Promise<void> {
    const timeout = this.#config.monkey.actionTimeoutMs;
    const facts = await withTimeout(page.evaluate<PageFacts>(READ_PAGE_FACTS), timeout).catch(() => undefined);
    // An evaluation that fails (the page is navigating, or closed) says nothing about the page.
    if (facts === undefined) return;
    const url = page.url();
    const path = this.#url(url);

    if (facts === TIMEOUT) {
      this.#add("hang", {
        severity: "high",
        key: `unresponsive|${path}`,
        message: `page did not respond within ${timeout}ms on ${url}`,
        url,
        details: { kind: "unresponsive" },
      });
      return;
    }

    // Staying on an overflowing page is one occurrence, not one per step.
    const previous = this.#overflow;
    this.#overflow = undefined;
    if (facts.scrollWidth > facts.clientWidth) {
      const culprit = normalizeMessage(this.#mask(facts.culprit));
      const key = `${path}|${culprit}`;
      this.#overflow = { page, key };
      if (navigated || previous?.page !== page || previous.key !== key) {
        this.#add("overflow", {
          severity: "low",
          key,
          message: `horizontal overflow on ${path}: ${facts.culprit} makes the page ${facts.scrollWidth}px wide in a ${facts.clientWidth}px viewport`,
          url,
          details: { ...facts, viewport: page.viewportSize() },
        });
      }
    }

    if (!navigated) return;
    const status = this.#documentStatus.get(page);
    const failed = status !== undefined && status >= 400;
    const looksBroken = ERROR_PAGE_PATTERNS.some((p) => p.test(facts.title) || p.test(facts.heading));
    // A failed status is the HTTP oracles' finding unless they are off; then this one reports it.
    if (failed ? !this.#httpCovers(status) : looksBroken) {
      this.#add("errorPage", {
        severity: "medium",
        key: `${path}|${status ?? ""}`,
        message: `error page on ${path}${status === undefined ? "" : ` (status ${status})`}: ${facts.title || facts.heading}`,
        url,
        details: { status, title: facts.title, heading: facts.heading },
      });
    }
  }

  /** Secrets are masked before a key is normalized, which would change a secret's digits and hide it from masking. */
  #mask(text: string): string {
    return this.#secrets?.mask(text) ?? text;
  }

  #url(url: string): string {
    return normalizeUrl(this.#mask(url), this.#origin);
  }

  #text(text: string): string {
    return normalizeMessage(this.#mask(text), this.#origin);
  }

  #add(oracle: OracleName, signal: Omit<Signal, "oracle">): void {
    if (!this.#config.oracles[oracle]) return;
    this.#pending.push({ oracle, ...signal, key: this.#mask(`${oracle}|${signal.key}`) });
  }

  async #flush(): Promise<void> {
    const signals = this.#pending;
    this.#pending = [];
    const fresh: Finding[] = [];
    for (const signal of signals) {
      if (this.#ignore.matches(signal)) continue;
      const existing = this.#byKey.get(signal.key);
      if (existing !== undefined) {
        existing.occurrences++;
        continue;
      }
      const finding: Finding = {
        id: `F${this.findings.length + 1}`,
        oracle: signal.oracle,
        severity: signal.severity,
        key: signal.key,
        message: signal.message,
        url: this.#page === undefined ? signal.url : safeUrl(this.#page),
        step: this.#step,
        role: this.#role,
        occurrences: 1,
        details: signal.details,
        lastActions: this.#history.map((entry) => ({ ...entry })),
      };
      this.#byKey.set(signal.key, finding);
      this.findings.push(finding);
      fresh.push(finding);
    }
    if (fresh.length === 0) return;
    const screenshotPath = await this.#screenshot();
    if (screenshotPath !== undefined) for (const finding of fresh) finding.screenshotPath = screenshotPath;
  }

  async #screenshot(): Promise<string | undefined> {
    const page = this.#page;
    if (page === undefined || page.isClosed() || this.#crashed.has(page)) return undefined;
    const path = join(this.#screenshotDir, `step-${String(this.#step).padStart(4, "0")}.png`);
    try {
      await mkdir(this.#screenshotDir, { recursive: true });
      const timeout = this.#config.monkey.actionTimeoutMs;
      // Without the fields marked, the screenshot could show a secret: none then.
      if ((await withTimeout(page.evaluate(markSecretFields(this.#typedSecrets)), timeout)) === TIMEOUT)
        return undefined;
      const mask = [page.locator(`[${SECRET_FIELD}]`)];
      // A frozen page ignores the screenshot's own timeout.
      const shot = await withTimeout(page.screenshot({ path, timeout, mask }), timeout);
      await withTimeout(page.evaluate(UNMARK_SECRET_FIELDS), timeout).catch(() => undefined);
      return shot === TIMEOUT ? undefined : path;
    } catch {
      return undefined;
    }
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function httpSeverity(status: number, isDocument: boolean): Signal["severity"] {
  if (status >= 500) return "high";
  return isDocument ? "medium" : "low";
}

function isMainFrameNavigation(page: Page, request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    return false;
  }
}
