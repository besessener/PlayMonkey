import { join } from "node:path";
import { launchBrowser } from "./auth/browser.ts";
import { ANONYMOUS_ROLE, LoginError, openRoleSession } from "./auth/session.ts";
import type { LoadedConfig } from "./config/config.ts";
import { maskSecrets, type Secrets } from "./config/secrets.ts";
import { type RunResult, runMonkey, type StepRecord } from "./monkey/loop.ts";
import type { Finding } from "./oracles/finding.ts";
import { Oracles } from "./oracles/oracles.ts";

export interface RoleOutcome {
  role: string;
  /** Absent when the role could not start (login failed). */
  result?: RunResult;
  /** Why the role could not start; masked. */
  error?: string;
  /** Deduplicated, in order of discovery; masked. Empty when the role could not start. */
  findings: Finding[];
  blockedNavigations: number;
}

export interface RunAllOptions {
  /** Called with a one-line message for every role start and end. */
  log: (line: string) => void;
  onStep?: (role: string, record: StepRecord) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Runs the monkey for every role (one anonymous role without `auth`) in sequence, each in its own browser context.
 * A role that cannot log in is recorded and the others still run.
 */
export async function runAllRoles(loaded: LoadedConfig, options: RunAllOptions): Promise<RoleOutcome[]> {
  const { config, secrets } = loaded;
  const browser = await launchBrowser(config.browser);
  const outcomes: RoleOutcome[] = [];
  try {
    const roles = config.auth.length > 0 ? config.auth : [undefined];
    for (const role of roles) {
      if (options.signal?.aborted) break;
      const name = role?.name ?? ANONYMOUS_ROLE;
      options.log(`[${secrets.mask(name)}] starting`);
      let session: Awaited<ReturnType<typeof openRoleSession>>;
      try {
        session = await openRoleSession(browser, role, {
          config,
          secrets,
          outputDir: join(config.report.dir, roleDirectory(name)),
        });
      } catch (error) {
        if (!(error instanceof LoginError)) throw error;
        options.log(`[${secrets.mask(name)}] ${error.message}`);
        outcomes.push({ role: name, error: error.message, findings: [], blockedNavigations: 0 });
        continue;
      }
      const roleDir = join(config.report.dir, roleDirectory(name));
      const oracles = new Oracles(session.context, {
        config,
        role: name,
        screenshotDir: join(roleDir, "screenshots"),
      });
      try {
        const result = await runMonkey(session.context, {
          config,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onStep: async (record) => {
            const pages = session.context.pages();
            await oracles.check(record, pages[record.result.tab] ?? pages[0]);
            await options.onStep?.(name, record);
          },
        });
        const findings = (await oracles.finish()).map((finding) => maskFinding(finding, secrets));
        outcomes.push({ role: name, result, findings, blockedNavigations: session.events.length });
        options.log(`[${secrets.mask(name)}] ${summarize(result)}, ${plural(findings.length, "finding")}`);
        for (const finding of findings) options.log(`[${secrets.mask(name)}]   ${describeFinding(finding)}`);
      } finally {
        const artifacts = await session.close();
        if (artifacts.tracePath !== undefined) options.log(`[${secrets.mask(name)}] trace: ${artifacts.tracePath}`);
      }
    }
  } finally {
    await browser.close();
  }
  return outcomes;
}

/** A directory name for a role: safe characters only. */
export function roleDirectory(role: string): string {
  return role.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

function summarize(result: RunResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const stop = result.stopReason === "error" ? `error: ${result.error}` : result.stopReason;
  return `${result.steps} steps in ${seconds}s, ${result.states} states, ${result.failedActions} failed actions, stopped: ${stop}`;
}

/** Masks everything a page could have echoed; the screenshot path is a local file path, like the trace path. */
function maskFinding(finding: Finding, secrets: Secrets): Finding {
  const { screenshotPath, ...rest } = finding;
  return { ...maskSecrets(rest, secrets), ...(screenshotPath === undefined ? {} : { screenshotPath }) };
}

/** One line per finding, e.g. `F1 high pageerror: Error: boom (step 12, 3×)`. */
export function describeFinding(finding: Finding): string {
  const times = finding.occurrences > 1 ? `, ${finding.occurrences}×` : "";
  return `${finding.id} ${finding.severity} ${finding.oracle}: ${finding.message} (step ${finding.step}${times})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
