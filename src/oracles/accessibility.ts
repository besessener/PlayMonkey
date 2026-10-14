import axe from "axe-core";
import type { Page } from "playwright";
import type { Signal } from "./finding.ts";
import { normalizeUrl } from "./keys.ts";

/** The WCAG 2.0 and 2.1 rules of levels A and AA; best practices are left out, they are opinions. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** Elements listed per violation in the finding's details. */
const MAX_TARGETS = 5;
/** An audit that failed or ran out of time. */
const TIMED_OUT = Symbol("timed out");

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  targets: string[];
  count: number;
}

/**
 * Evaluated in the page after axe-core (a string, because `src` has no DOM types): the violations of the main
 * document; iframes are not audited.
 */
const AUDIT = `(async () => {
  const results = await globalThis.axe.run(document, {
    runOnly: { type: "tag", values: ${JSON.stringify(TAGS)} },
    resultTypes: ["violations"],
  });
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    targets: v.nodes.slice(0, ${MAX_TARGETS}).map((node) => node.target.join(" ")),
    count: v.nodes.length,
  }));
})()`;

/**
 * The `accessibility` oracle: audits every page of a run once, by its normalized URL (ids and query dropped), with
 * axe-core. One signal per violated rule and page; serious and critical impact are `medium`, the rest `low`.
 */
export class AccessibilityAudit {
  readonly #origin: string;
  readonly #audited = new Set<string>();
  /** The last audit, settled either way; a timed-out one may still run in the page. */
  #running: Promise<void> | undefined;

  constructor(origin: string) {
    this.#origin = origin;
  }

  /**
   * The violations of `page` when it was not audited yet. None when the audit fails (navigating, closed) or times
   * out; a failed audit says nothing about the page, so the next visit tries again.
   */
  async audit(page: Page, timeoutMs: number): Promise<Omit<Signal, "oracle">[]> {
    const url = page.url();
    const path = normalizeUrl(url, this.#origin);
    if (this.#audited.has(path) || !(await this.#idle(timeoutMs))) return [];
    const running = run(page);
    this.#running = running.then(
      () => undefined,
      () => undefined,
    );
    const violations = await withTimeout(running, timeoutMs).catch((): typeof TIMED_OUT => TIMED_OUT);
    if (violations === TIMED_OUT) return [];
    this.#audited.add(path);
    return violations.map((violation) => ({
      severity: violation.impact === "critical" || violation.impact === "serious" ? "medium" : "low",
      key: `${violation.id}|${path}`,
      message: `${violation.id} on ${path}: ${violation.help} (${violation.count} element${violation.count === 1 ? "" : "s"})`,
      url,
      details: {
        rule: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        targets: violation.targets,
      },
    }));
  }

  /** True once the previous audit has settled: axe runs one audit at a time per page. */
  async #idle(timeoutMs: number): Promise<boolean> {
    if (this.#running === undefined) return true;
    if ((await withTimeout(this.#running, timeoutMs)) === TIMED_OUT) return false;
    this.#running = undefined;
    return true;
  }
}

/** Injects axe-core once per document, through the protocol, so a strict Content-Security-Policy cannot block it. */
async function run(page: Page): Promise<Violation[]> {
  // Evaluates to undefined, not to axe itself, which Playwright would try to serialize.
  if ((await page.evaluate("typeof globalThis.axe")) === "undefined") await page.evaluate(`${axe.source}\n;undefined`);
  return await page.evaluate<Violation[]>(AUDIT);
}

/** The promise's value, or `TIMED_OUT` after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // An audit that outlived its time settles when the page navigates or closes; nobody waits for it any more.
    promise.catch(() => undefined);
  }
}
