import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "./auth/browser.ts";
import { ANONYMOUS_ROLE, LoginError, openRoleSession } from "./auth/session.ts";
import type { AuthRole, LoadedConfig } from "./config/config.ts";
import { maskSecrets, type Secrets } from "./config/secrets.ts";
import { type ReplayPlan, type RunResult, runMonkey, type StepRecord } from "./monkey/loop.ts";
import type { Finding } from "./oracles/finding.ts";
import { Oracles } from "./oracles/oracles.ts";
import { ActionLogWriter } from "./replay/log.ts";

export interface RoleOutcome {
  role: string;
  /** Absent when the role could not start (login failed). */
  result?: RunResult;
  /** Why the role could not start; masked. */
  error?: string;
  /** Deduplicated, in order of discovery; masked. Empty when the role could not start. */
  findings: Finding[];
  blockedNavigations: number;
  /** The role's `actions.json`, when one was written. */
  actionLog?: string;
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
  const { config } = loaded;
  const browser = await launchBrowser(config.browser);
  const outcomes: RoleOutcome[] = [];
  try {
    const roles = config.auth.length > 0 ? config.auth : [undefined];
    for (const role of roles) {
      if (options.signal?.aborted) break;
      const name = role?.name ?? ANONYMOUS_ROLE;
      outcomes.push(
        await runRole(browser, role, loaded, {
          log: options.log,
          outputDir: join(config.report.dir, roleDirectory(name)),
          actionLog: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onStep === undefined ? {} : { onStep: (record) => options.onStep?.(name, record) }),
        }),
      );
    }
  } finally {
    await browser.close();
  }
  return outcomes;
}

export interface RoleOptions {
  log: (line: string) => void;
  /** Directory for the trace, video, screenshots and `actions.json`. */
  outputDir: string;
  /** Write `actions.json`. */
  actionLog: boolean;
  /** Replay these actions instead of running the random monkey. */
  replay?: ReplayPlan;
  onStep?: (record: StepRecord) => void | Promise<void>;
  signal?: AbortSignal;
}

/** Logs in as one role (or anonymously), runs the monkey or a replay with the oracles, and closes the session. */
export async function runRole(
  browser: Browser,
  role: AuthRole | undefined,
  loaded: Pick<LoadedConfig, "config" | "secrets">,
  options: RoleOptions,
): Promise<RoleOutcome> {
  const { config, secrets } = loaded;
  const name = role?.name ?? ANONYMOUS_ROLE;
  const log = (line: string) => options.log(`[${secrets.mask(name)}] ${line}`);
  log(options.replay === undefined ? "starting" : `replaying ${plural(options.replay.actions.length, "action")}`);
  let session: Awaited<ReturnType<typeof openRoleSession>>;
  try {
    session = await openRoleSession(browser, role, { config, secrets, outputDir: options.outputDir });
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    log(error.message);
    return { role: name, error: error.message, findings: [], blockedNavigations: 0 };
  }
  const oracles = new Oracles(session.context, {
    config,
    role: name,
    screenshotDir: join(options.outputDir, "screenshots"),
  });
  let writer: ActionLogWriter | undefined;
  if (options.actionLog) {
    await mkdir(options.outputDir, { recursive: true });
    writer = new ActionLogWriter(
      join(options.outputDir, "actions.json"),
      { seed: config.seed, baseUrl: config.baseUrl, role: name, viewport: config.browser.viewport },
      secrets,
    );
  }
  try {
    const result = await runMonkey(session.context, {
      config,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      onStep: async (record) => {
        const pages = session.context.pages();
        await oracles.check(record, pages[record.result.tab] ?? pages[0]);
        if (record.skipped === true) log(`step ${record.step} skipped: ${secrets.mask(record.result.error ?? "")}`);
        await writer?.append(record);
        await options.onStep?.(record);
      },
    });
    const raw = await oracles.finish();
    await writer?.setFindings(raw);
    const findings = raw.map((finding) => maskFinding(finding, secrets));
    log(`${secrets.mask(summarize(result))}, ${plural(findings.length, "finding")}`);
    for (const finding of findings) log(`  ${describeFinding(finding)}`);
    if (writer !== undefined) log(`actions: ${writer.file}`);
    return {
      role: name,
      result,
      findings,
      blockedNavigations: session.events.length,
      ...(writer === undefined ? {} : { actionLog: writer.file }),
    };
  } finally {
    const artifacts = await session.close();
    if (artifacts.tracePath !== undefined) log(`trace: ${artifacts.tracePath}`);
  }
}

/** A directory name for a role: safe characters only. */
export function roleDirectory(role: string): string {
  return role.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

function summarize(result: RunResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const stop = result.stopReason === "error" ? `error: ${result.error}` : result.stopReason;
  const skipped = result.skippedActions > 0 ? `, ${result.skippedActions} skipped` : "";
  return `${result.steps} steps in ${seconds}s, ${result.states} states, ${result.failedActions} failed actions${skipped}, stopped: ${stop}`;
}

/** Masks everything a page could have echoed; the screenshot path is a local file path, like the trace path. */
export function maskFinding(finding: Finding, secrets: Secrets): Finding {
  const { screenshotPath, ...rest } = finding;
  return { ...maskSecrets(rest, secrets), ...(screenshotPath === undefined ? {} : { screenshotPath }) };
}

/** One line per finding, e.g. `F1 high pageerror: Error: boom (step 12, 3×)`. */
export function describeFinding(finding: Finding): string {
  const times = finding.occurrences > 1 ? `, ${finding.occurrences}×` : "";
  return `${finding.id} ${finding.severity} ${finding.oracle}: ${finding.message} (step ${finding.step}${times})`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
