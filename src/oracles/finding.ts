import type { IgnoreRule } from "../config/config.ts";
import type { OracleName } from "../config/schema.ts";
import type { Action } from "../monkey/actions.ts";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One action before a finding, enough to replay the way there. */
export interface ActionContext {
  step: number;
  action: Action;
  locator?: string;
  /** URL the action was chosen on. */
  url: string;
}

/** A deduplicated problem. Holds the context of its first occurrence; later ones only raise `occurrences`. */
export interface Finding {
  /** `F1`, `F2`, … in order of discovery within a role. */
  id: string;
  oracle: OracleName;
  severity: Severity;
  /** Dedup key; the same key in another run or a replay is the same bug. */
  key: string;
  message: string;
  /** Page URL when the finding was detected. */
  url: string;
  /** Step after which the finding was detected (0: before the first action). */
  step: number;
  role: string;
  occurrences: number;
  /** Oracle-specific facts, e.g. status and request URL for HTTP findings. */
  details: Record<string, unknown>;
  /** The last `findings.lastActions` actions up to and including `step`, oldest first. */
  lastActions: ActionContext[];
  /** Absolute path of a screenshot taken right after detection; absent when the page could not be captured. */
  screenshotPath?: string;
}

/** A problem as an oracle sees it, before ignore rules and deduplication. */
export interface Signal {
  oracle: OracleName;
  severity: Severity;
  key: string;
  message: string;
  /** What ignore rules match `url` against: the request URL for HTTP signals, else the page URL. */
  url: string;
  details: Record<string, unknown>;
}

/** Compiled `findings.ignore` rules. */
export class IgnoreRules {
  readonly #rules: { oracle?: OracleName; url?: RegExp; message?: RegExp }[];

  constructor(rules: IgnoreRule[]) {
    this.#rules = rules.map((rule) => ({
      ...(rule.oracle === undefined ? {} : { oracle: rule.oracle }),
      ...(rule.url === undefined ? {} : { url: new RegExp(rule.url) }),
      ...(rule.message === undefined ? {} : { message: new RegExp(rule.message) }),
    }));
  }

  /** True when one rule matches every part it sets. */
  matches(signal: Pick<Signal, "oracle" | "url" | "message">): boolean {
    return this.#rules.some(
      (rule) =>
        (rule.oracle === undefined || rule.oracle === signal.oracle) &&
        (rule.url === undefined || rule.url.test(signal.url)) &&
        (rule.message === undefined || rule.message.test(signal.message)),
    );
  }
}
