import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, ConsoleMessage, Page, Response } from "playwright";
import type { Config } from "../config/config.ts";
import type { OracleName } from "../config/schema.ts";
import type { StepRecord } from "../monkey/loop.ts";
import { type ActionContext, type Finding, IgnoreRules, type Signal } from "./finding.ts";
import { firstStackFrame, normalizeMessage, normalizeUrl } from "./keys.ts";

export interface OracleOptions {
  config: Config;
  role: string;
  /** Directory for finding screenshots; created on the first finding. */
  screenshotDir: string;
}

/** Title or main heading of a page that is an error page, whatever its status. */
const ERROR_PAGE_PATTERNS = [
  /\bnot found\b/i,
  /\b(internal )?server error\b/i,
  /\bsomething went wrong\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\baccess denied\b/i,
  /\bforbidden\b/i,
  /\b(an|unexpected) error (has )?occurred\b/i,
  /^\s*(error\s*)?[45]\d\d\b/i,
];

/** Chromium's console echo of a failed HTTP response: the response itself is the HTTP oracles' business. */
const FAILED_RESOURCE = /^Failed to load resource: the server responded with a status of (\d{3})\b/;

interface PageFacts {
  scrollWidth: number;
  clientWidth: number;
  title: string;
  heading: string;
  /** The outermost element sticking out on the right, e.g. `div.banner`. */
  culprit: string;
}

const TIMEOUT = Symbol("timeout");

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
  readonly #origin: string;
  readonly #ignore: IgnoreRules;
  readonly #byKey = new Map<string, Finding>();
  readonly #history: ActionContext[] = [];
  readonly #documentStatus = new WeakMap<Page, number>();
  readonly #crashed = new WeakSet<Page>();
  /** Overflow seen by the previous check, to count a page that stays overflowing once. */
  #overflow: { page: Page; key: string } | undefined;
  #pending: Signal[] = [];
  #step = 0;
  #page: Page | undefined;

  constructor(context: BrowserContext, options: OracleOptions) {
    this.#config = options.config;
    this.#role = options.role;
    this.#screenshotDir = options.screenshotDir;
    this.#origin = new URL(options.config.baseUrl).origin;
    this.#ignore = new IgnoreRules(options.config.findings.ignore);
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

    if (record.result.hang === true) {
      this.#add("hang", {
        severity: "high",
        key: `navigation|${normalizeUrl(record.result.url, this.#origin)}`,
        message: `page did not load within ${this.#config.monkey.actionTimeoutMs}ms: ${record.result.error ?? ""}`,
        url: record.result.url,
        details: { kind: "navigation", action: record.action, error: record.result.error },
      });
    }
    for (const event of record.events ?? []) {
      if (event.kind !== "download" || event.failure === undefined) continue;
      const path = normalizeUrl(event.url, this.#origin);
      this.#add("download", {
        severity: "medium",
        key: path,
        message: `download of ${event.name} from ${path} failed: ${event.failure}`,
        url: event.url,
        details: { name: event.name, url: event.url, failure: event.failure },
      });
    }
    if (page !== undefined && !this.#crashed.has(page) && /^https?:/.test(page.url())) {
      await this.#inspect(page, record.result.navigated);
    }
    await this.#flush();
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
        key: `${normalizeMessage(message, this.#origin)}|${firstStackFrame(error.stack, this.#origin)}`,
        message,
        url: safeUrl(page),
        details: { stack: (error.stack ?? "").split("\n").slice(0, 10).join("\n") },
      });
    });
    page.on("console", (message) => this.#onConsole(page, message));
    page.on("response", (response) => this.#onResponse(page, response));
    page.on("crash", () => {
      this.#crashed.add(page);
      this.#add("crash", {
        severity: "critical",
        key: normalizeUrl(safeUrl(page), this.#origin),
        message: `page crashed on ${safeUrl(page)}`,
        url: safeUrl(page),
        details: {},
      });
    });
  }

  #onConsole(page: Page, message: ConsoleMessage): void {
    if (message.type() !== "error") return;
    const text = message.text();
    if (FAILED_RESOURCE.test(text)) return;
    const location = message.location();
    this.#add("console", {
      severity: "medium",
      key: normalizeMessage(text, this.#origin),
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
    const path = normalizeUrl(url, this.#origin);
    this.#add(oracle, {
      severity: httpSeverity(status, isDocument),
      key: `${method} ${path} ${status}`,
      message: `${method} ${path} responded ${status}${response.statusText() === "" ? "" : ` ${response.statusText()}`}`,
      url,
      details: { method, url, status, statusText: response.statusText(), resourceType: request.resourceType() },
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
    const path = normalizeUrl(url, this.#origin);

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
      const culprit = normalizeMessage(facts.culprit);
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

  #add(oracle: OracleName, signal: Omit<Signal, "oracle">): void {
    if (!this.#config.oracles[oracle]) return;
    this.#pending.push({ oracle, ...signal, key: `${oracle}|${signal.key}` });
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
      await page.screenshot({ path, timeout: this.#config.monkey.actionTimeoutMs });
      return path;
    } catch {
      return undefined;
    }
  }
}

/**
 * Evaluated in the page (a string, because `src` has no DOM types). For overflow, the culprit is the first element in
 * document order that sticks out on the right while its parent does not.
 */
const READ_PAGE_FACTS = `(() => {
  const root = document.documentElement;
  const width = root.clientWidth;
  let culprit = "document";
  if (root.scrollWidth > width && document.body !== null) {
    const right = (element) => element.getBoundingClientRect().right + window.scrollX;
    for (const element of document.body.querySelectorAll("*")) {
      if (right(element) <= width + 1) continue;
      const parent = element.parentElement;
      if (parent === null || parent === document.body || right(parent) <= width + 1) {
        const id = element.id === "" ? "" : "#" + element.id;
        const classes = [...element.classList].slice(0, 2).map((name) => "." + name).join("");
        culprit = element.localName + id + classes;
        break;
      }
    }
  }
  return {
    scrollWidth: root.scrollWidth,
    clientWidth: width,
    title: document.title,
    heading: document.querySelector("h1")?.textContent?.trim() ?? "",
    culprit,
  };
})()`;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // A hung evaluation settles when the page is closed; nobody waits for it any more.
    promise.catch(() => undefined);
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
