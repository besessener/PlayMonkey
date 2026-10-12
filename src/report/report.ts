import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { LoadedConfig } from "../config/config.ts";
import { maskSecrets } from "../config/secrets.ts";
import type { LlmReport } from "../llm/usage.ts";
import type { StopReason } from "../monkey/loop.ts";
import { type Finding, SEVERITIES, type Severity } from "../oracles/finding.ts";
import type { RoleOutcome } from "../run.ts";
import { renderHtml } from "./html.ts";

export const REPORT_VERSION = 1;

/** `report.json`. Paths are relative to the report directory; every string is masked. */
export interface Report {
  version: typeof REPORT_VERSION;
  tool: { name: "playmonkey"; version: string };
  startedAt: string;
  finishedAt: string;
  seed: number;
  /** The config with defaults applied and every secret value masked. */
  config: unknown;
  roles: RoleSummary[];
  /** All roles' findings: by severity, then occurrences, then discovery. */
  findings: ReportFinding[];
  counts: Record<Severity, number>;
  /** LLM usage; present when `llm` is configured. */
  llm?: LlmReport;
}

export interface RoleSummary {
  role: string;
  /** Absent when the role could not start. */
  steps?: number;
  durationMs?: number;
  stopReason?: StopReason;
  /** Why the run stopped with `error`, or why the role could not start. */
  error?: string;
  states?: number;
  failedActions?: number;
  findings: number;
  blockedNavigations: number;
  actionLog?: string;
  trace?: string;
  videos: string[];
}

export type ReportFinding = Omit<Finding, "screenshotPath"> & { screenshot?: string };

export interface ReportInput {
  loaded: LoadedConfig;
  outcomes: RoleOutcome[];
  version: string;
  startedAt: Date;
  finishedAt: Date;
  llm?: LlmReport;
}

/** Builds the report from the run's in-memory result. Findings in `outcomes` are already masked. */
export function buildReport(input: ReportInput): Report {
  const { config, secrets } = input.loaded;
  const dir = config.report.dir;
  const path = (file: string) => relative(dir, file).split(sep).join("/");

  const findings = input.outcomes
    .flatMap((outcome) => outcome.findings)
    .map(({ screenshotPath, ...finding }) => ({
      ...finding,
      ...(screenshotPath === undefined ? {} : { screenshot: path(screenshotPath) }),
    }));
  const order = (finding: ReportFinding) => SEVERITIES.indexOf(finding.severity);
  findings.sort((a, b) => order(a) - order(b) || b.occurrences - a.occurrences);

  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  for (const finding of findings) counts[finding.severity]++;

  const roles = input.outcomes.map((outcome): RoleSummary => {
    const result = outcome.result;
    const error = result?.error ?? outcome.error;
    return {
      role: secrets.mask(outcome.role),
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
      findings: outcome.findings.length,
      blockedNavigations: outcome.blockedNavigations,
      ...(outcome.actionLog === undefined ? {} : { actionLog: path(outcome.actionLog) }),
      ...(outcome.tracePath === undefined ? {} : { trace: path(outcome.tracePath) }),
      videos: (outcome.videoPaths ?? []).map(path),
    };
  });

  return {
    version: REPORT_VERSION,
    tool: { name: "playmonkey", version: input.version },
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    seed: config.seed,
    config: maskSecrets(config, secrets),
    roles,
    findings,
    counts,
    ...(input.llm === undefined ? {} : { llm: maskSecrets(input.llm, secrets) }),
  };
}

/** Writes `report.json` and the self-contained `report.html` into the report directory; returns their paths. */
export async function writeReport(report: Report, dir: string): Promise<{ json: string; html: string }> {
  const json = join(dir, "report.json");
  const html = join(dir, "report.html");
  // Exists already unless no role could start.
  await mkdir(dir, { recursive: true });
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
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
