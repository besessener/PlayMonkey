import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { LoadedConfig } from "../config/config.ts";
import { maskSecrets, type Secrets } from "../config/secrets.ts";
import type { LlmReport } from "../llm/usage.ts";
import type { StopReason } from "../monkey/loop.ts";
import { type Finding, SEVERITIES, type Severity } from "../oracles/finding.ts";
import type { RoleOutcome } from "../run.ts";
import { type Baseline, type BaselineComparison, compareBaseline, toBaseline } from "./baseline.ts";
import { aggregateCoverage, type ReportCoverage } from "./coverage.ts";
import { renderHtml } from "./html.ts";

export const REPORT_VERSION = 1;

/** `report.json`. Paths are relative to the report directory; every string is masked. */
export interface Report {
  version: typeof REPORT_VERSION;
  tool: { name: "playmonkey"; version: string };
  startedAt: string;
  finishedAt: string;
  /** The seed, or with `seeds` the first of them. */
  seed: number;
  /** Present with `seeds` in the config. */
  seeds?: number[];
  /** The config with defaults applied and every secret value masked. */
  config: unknown;
  /** One entry per run (role and seed), in config order: roles, then seeds. */
  roles: RoleSummary[];
  /** Every run's findings, deduplicated per run: by severity, then occurrences, then run order and discovery. */
  findings: ReportFinding[];
  /** The findings across runs: one entry per dedup key, with the runs that found it. */
  aggregated: AggregatedFinding[];
  /** Aggregated findings per severity. */
  counts: Record<Severity, number>;
  /** The pages all runs acted on, and linked ones none reached. */
  coverage: ReportCoverage;
  /** How the findings compare with `findings.baseline`; present when it is configured. */
  baseline?: BaselineComparison;
  /** LLM usage; present when `llm` is configured. */
  llm?: LlmReport;
}

export interface RoleSummary {
  role: string;
  seed: number;
  /** Absent when the role could not start. */
  steps?: number;
  durationMs?: number;
  stopReason?: StopReason;
  /** Why the run stopped with `error`, or why the role could not start. */
  error?: string;
  states?: number;
  failedActions?: number;
  /** Distinct pages the run acted on. */
  pages?: number;
  findings: number;
  blockedNavigations: number;
  actionLog?: string;
  trace?: string;
  videos: string[];
}

export type ReportFinding = Omit<Finding, "screenshotPath"> & { seed: number; screenshot?: string };

/** One problem across runs. Message, URL and severity are those of the first run that found it. */
export interface AggregatedFinding {
  key: string;
  oracle: Finding["oracle"];
  severity: Severity;
  message: string;
  url: string;
  /** Sum over all runs. */
  occurrences: number;
  /** Distinct roles that found it, in config order. */
  roles: string[];
  /** Every run that found it, in run order, with the finding's per-run id. */
  runs: { role: string; seed: number; id: string }[];
  /** With `findings.baseline`: whether the baseline lists it. */
  known?: boolean;
}

export interface ReportInput {
  loaded: LoadedConfig;
  outcomes: RoleOutcome[];
  version: string;
  startedAt: Date;
  finishedAt: Date;
  llm?: LlmReport;
  /** The baseline of `findings.baseline`, read before the run. */
  baseline?: Baseline;
}

/** Builds the report from the run's in-memory result. Findings in `outcomes` are already masked. */
export function buildReport(input: ReportInput): Report {
  const { config, secrets } = input.loaded;
  const dir = config.report.dir;
  const path = (file: string) => relative(dir, file).split(sep).join("/");

  // Run order first, so the stable sort below breaks ties deterministically, whatever order the runs finished in.
  const findings: ReportFinding[] = input.outcomes.flatMap((outcome) =>
    outcome.findings.map(({ screenshotPath, ...finding }) => ({
      ...finding,
      seed: outcome.seed,
      ...(screenshotPath === undefined ? {} : { screenshot: path(screenshotPath) }),
    })),
  );
  const aggregated = aggregate(findings);
  const order = (finding: { severity: Severity }) => SEVERITIES.indexOf(finding.severity);
  findings.sort((a, b) => order(a) - order(b) || b.occurrences - a.occurrences);
  const groups = aggregated.sort(
    (a, b) => order(a) - order(b) || b.runs.length - a.runs.length || b.occurrences - a.occurrences,
  );

  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  for (const finding of groups) counts[finding.severity]++;

  const roles = input.outcomes.map((outcome) => summarizeRun(outcome, secrets, path));
  const baselineFile = config.findings.baseline;
  const compared =
    input.baseline === undefined || baselineFile === undefined
      ? undefined
      : compareBaseline(groups, input.baseline, path(baselineFile));

  return {
    version: REPORT_VERSION,
    tool: { name: "playmonkey", version: input.version },
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    seed: config.seed,
    ...(config.seeds === undefined ? {} : { seeds: [...config.seeds] }),
    config: maskSecrets(config, secrets),
    roles,
    findings,
    aggregated: compared?.findings ?? groups,
    counts,
    coverage: maskSecrets(aggregateCoverage(input.outcomes), secrets),
    ...(compared === undefined ? {} : { baseline: compared.comparison }),
    ...(input.llm === undefined ? {} : { llm: maskSecrets(input.llm, secrets) }),
  };
}

/** The findings across runs, one entry per dedup key, in order of first appearance. */
function aggregate(findings: ReportFinding[]): AggregatedFinding[] {
  const aggregated = new Map<string, AggregatedFinding>();
  for (const finding of findings) {
    let entry = aggregated.get(finding.key);
    if (entry === undefined) {
      entry = {
        key: finding.key,
        oracle: finding.oracle,
        severity: finding.severity,
        message: finding.message,
        url: finding.url,
        occurrences: 0,
        roles: [],
        runs: [],
      };
      aggregated.set(finding.key, entry);
    }
    entry.occurrences += finding.occurrences;
    if (!entry.roles.includes(finding.role)) entry.roles.push(finding.role);
    entry.runs.push({ role: finding.role, seed: finding.seed, id: finding.id });
  }
  return [...aggregated.values()];
}

function summarizeRun(outcome: RoleOutcome, secrets: Secrets, path: (file: string) => string): RoleSummary {
  const result = outcome.result;
  const error = result?.error ?? outcome.error;
  return {
    role: secrets.mask(outcome.role),
    seed: outcome.seed,
    ...(result === undefined
      ? {}
      : {
          steps: result.steps,
          durationMs: result.durationMs,
          stopReason: result.stopReason,
          states: result.states,
          failedActions: result.failedActions,
        }),
    ...(error === undefined ? {} : { error: secrets.mask(error) }),
    ...(outcome.coverage === undefined ? {} : { pages: outcome.coverage.pages.length }),
    findings: outcome.findings.length,
    blockedNavigations: outcome.blockedNavigations,
    ...(outcome.actionLog === undefined ? {} : { actionLog: path(outcome.actionLog) }),
    ...(outcome.tracePath === undefined ? {} : { trace: path(outcome.tracePath) }),
    videos: (outcome.videoPaths ?? []).map(path),
  };
}

/**
 * Writes `report.json`, the self-contained `report.html` and `baseline.json` (this run's findings, to adopt as
 * `findings.baseline`) into the report directory; returns the paths of the reports.
 */
export async function writeReport(report: Report, dir: string): Promise<{ json: string; html: string }> {
  const json = join(dir, "report.json");
  const html = join(dir, "report.html");
  // Exists already unless no role could start.
  await mkdir(dir, { recursive: true });
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "baseline.json"), `${JSON.stringify(toBaseline(report.aggregated), null, 2)}\n`);
  const screenshots = new Map<string, string>();
  for (const finding of report.findings) {
    if (finding.screenshot === undefined || screenshots.has(finding.screenshot)) continue;
    try {
      const data = await readFile(join(dir, finding.screenshot));
      screenshots.set(finding.screenshot, `data:image/png;base64,${data.toString("base64")}`);
    } catch {
      // A missing screenshot only loses the picture.
    }
  }
  await writeFile(html, renderHtml(report, screenshots));
  return { json, html };
}
