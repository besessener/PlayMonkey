import { normalizeUrl } from "../oracles/keys.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import type { StepRecord } from "./loop.ts";
import type { UrlScope } from "./scope.ts";

/** One page of a run, by normalized URL (ids and query dropped, like dedup keys). */
export interface PageCoverage {
  page: string;
  /** Steps whose action was chosen on this page. */
  steps: number;
  /** Distinct snapshot hashes seen on it. */
  states: number;
}

/** Which pages a run acted on, and which ones it saw links to but never reached. */
export interface RunCoverage {
  /** Sorted by page. */
  pages: PageCoverage[];
  /** Pages linked from visited ones that the run may open but never acted on, sorted. */
  unvisited: string[];
}

export interface CoverageOptions {
  /** Origin of `baseUrl`; dropped from page names. */
  origin: string;
  /** With `stayOnDomain`: links elsewhere do not count as reachable. */
  stayOnDomain: boolean;
  scope: UrlScope;
}

/** Collects the coverage of one run from its steps. */
export class CoverageTracker {
  readonly #options: CoverageOptions;
  readonly #pages = new Map<string, { steps: number; states: Set<string> }>();
  readonly #linked = new Set<string>();

  constructor(options: CoverageOptions) {
    this.#options = options;
  }

  /** A step and the snapshot its action was chosen in. */
  record(record: StepRecord, snapshot: Snapshot): void {
    const page = normalizeUrl(record.url, this.#options.origin);
    const entry = this.#pages.get(page) ?? { steps: 0, states: new Set<string>() };
    entry.steps++;
    entry.states.add(record.snapshotHash);
    this.#pages.set(page, entry);
    for (const element of snapshot.elements) {
      if (element.role !== "link" || element.url === undefined) continue;
      const target = this.#reachable(element.url, snapshot.url);
      if (target !== undefined) this.#linked.add(normalizeUrl(target, this.#options.origin));
    }
  }

  summary(): RunCoverage {
    const pages = [...this.#pages.entries()]
      .map(([page, { steps, states }]) => ({ page, steps, states: states.size }))
      .sort((a, b) => a.page.localeCompare(b.page));
    const unvisited = [...this.#linked].filter((page) => !this.#pages.has(page)).sort();
    return { pages, unvisited };
  }

  /** The absolute link target when the run may open it, else undefined. */
  #reachable(href: string, pageUrl: string): string | undefined {
    let target: URL;
    try {
      target = new URL(href, pageUrl);
    } catch {
      return undefined;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    if (this.#options.stayOnDomain && target.origin !== this.#options.origin) return undefined;
    return this.#options.scope.allows(target.href) ? target.href : undefined;
  }
}
