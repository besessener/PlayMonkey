import { readFile } from "node:fs/promises";
import type { AggregatedFinding } from "./report.ts";

export const BASELINE_VERSION = 1;

/** One known finding: its dedup key decides; the rest is for people reading the file. */
export interface BaselineEntry {
  key: string;
  oracle: string;
  severity: string;
  message: string;
}

/** `baseline.json`: the findings of a run, sorted by key so that diffs stay small. Masked like the report. */
export interface Baseline {
  version: typeof BASELINE_VERSION;
  findings: BaselineEntry[];
}

/** How the findings of a run compare with a baseline. */
export interface BaselineComparison {
  /** The baseline file, as configured. */
  file: string;
  /** Findings of this run that the baseline lists. */
  known: number;
  /** Findings of this run that it does not: these decide the exit code. */
  new: number;
  /** Baseline entries this run did not find: fixed, or just not reached this time. */
  unseen: BaselineEntry[];
}

/** The baseline cannot be read. Maps to exit code 2. */
export class BaselineError extends Error {
  constructor(file: string, reason: string) {
    super(`baseline ${file}: ${reason}`);
    this.name = "BaselineError";
  }
}

/** The baseline of a run's aggregated findings. */
export function toBaseline(findings: AggregatedFinding[]): Baseline {
  return {
    version: BASELINE_VERSION,
    findings: findings
      .map(({ key, oracle, severity, message }) => ({ key, oracle, severity, message }))
      .sort((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key))),
  };
}

/** Reads and checks a `baseline.json`. */
export async function readBaseline(file: string): Promise<Baseline> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const reason =
      error instanceof SyntaxError
        ? `invalid JSON: ${error.message}`
        : `cannot read file (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); write one by copying baseline.json from a report directory`;
    throw new BaselineError(file, reason);
  }
  const baseline = json as Partial<Baseline> | null;
  if (baseline?.version !== BASELINE_VERSION) {
    throw new BaselineError(
      file,
      `unsupported version ${JSON.stringify(baseline?.version)}; expected ${BASELINE_VERSION}`,
    );
  }
  if (!(Array.isArray(baseline.findings) && baseline.findings.every((entry) => typeof entry?.key === "string"))) {
    throw new BaselineError(file, "findings must be a list of entries with a key");
  }
  return baseline as Baseline;
}

/** Marks every aggregated finding as known or new and lists what the baseline has that this run did not find. */
export function compareBaseline(
  findings: AggregatedFinding[],
  baseline: Baseline,
  file: string,
): { findings: AggregatedFinding[]; comparison: BaselineComparison } {
  const listed = new Set(baseline.findings.map((entry) => entry.key));
  const found = new Set(findings.map((finding) => finding.key));
  const marked = findings.map((finding) => ({ ...finding, known: listed.has(finding.key) }));
  const known = marked.filter((finding) => finding.known).length;
  return {
    findings: marked,
    comparison: {
      file,
      known,
      new: marked.length - known,
      unseen: baseline.findings.filter((entry) => !found.has(entry.key)),
    },
  };
}
