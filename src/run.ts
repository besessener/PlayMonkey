import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "./auth/browser.ts";
import { ANONYMOUS_ROLE, LoginError, openRoleSession } from "./auth/session.ts";
import type { AuthRole, LoadedConfig } from "./config/config.ts";
import { maskSecrets, type Secrets } from "./config/secrets.ts";
import { DebugLog } from "./llm/debug-log.ts";
import { LlmDriver } from "./llm/driver.ts";
import { PromptPlaceholders } from "./llm/placeholders.ts";
import type { LlmProvider } from "./llm/provider.ts";
import { StuckDetector } from "./llm/stuck.ts";
import { describeUsage, type LlmStats } from "./llm/usage.ts";
import { type Action, describeAction } from "./monkey/actions.ts";
import { describeEvent, removeDownloads } from "./monkey/events.ts";
import { type ReplayPlan, type RunResult, runMonkey, type StepRecord } from "./monkey/loop.ts";
import type { Spectator } from "./monkey/spectator.ts";
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
  /** Playwright trace and videos of the role's context; absent when the role could not start. */
  tracePath?: string;
  videoPaths?: string[];
}

export interface RunAllOptions {
  /** Called with a one-line message for every role start and end. */
  log: (line: string) => void;
  onStep?: (role: string, record: StepRecord) => void | Promise<void>;
  signal?: AbortSignal;
  /** The LLM for stuck situations; shared by all roles, like its budget. Requires `config.llm`. */
  llm?: RunLlm;
  /** Spectator mode (`--watch`): visible, slowed-down browser and one console line per step. */
  spectator?: Spectator;
}

export interface RunLlm {
  provider: LlmProvider;
  stats: LlmStats;
  debugLog?: DebugLog;
}

/**
 * Runs the monkey for every role (one anonymous role without `auth`) in sequence, each in its own browser context.
 * A role that cannot log in is recorded and the others still run.
 */
export async function runAllRoles(loaded: LoadedConfig, options: RunAllOptions): Promise<RoleOutcome[]> {
  const { config } = loaded;
  let llm = options.llm;
  if (llm !== undefined && config.llm?.debugLog === true && llm.debugLog === undefined) {
    const file = join(config.report.dir, "llm-debug.jsonl");
    await rm(file, { force: true });
    llm = { ...llm, debugLog: new DebugLog(file, loaded.secrets) };
  }
  const browser = await launchBrowser(
    config.browser,
    options.spectator === undefined ? {} : { spectator: options.spectator },
  );
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
          ...(llm === undefined ? {} : { llm }),
          ...(options.spectator === undefined ? {} : { spectator: options.spectator }),
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
  /** Ignored with `replay`, which never asks an LLM. */
  llm?: RunLlm;
  /** Outline elements before acting and log every step; the browser must have been launched for it. */
  spectator?: Spectator;
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
  let outcome: RoleOutcome | undefined;
  if (options.actionLog) {
    await mkdir(options.outputDir, { recursive: true });
    writer = new ActionLogWriter(
      join(options.outputDir, "actions.json"),
      { seed: config.seed, baseUrl: config.baseUrl, role: name, viewport: config.browser.viewport },
      secrets,
    );
  }
  const advisor =
    options.replay === undefined && options.llm !== undefined && config.llm !== undefined
      ? new LlmDriver({
          provider: options.llm.provider,
          config: config.llm,
          stats: options.llm.stats,
          detector: new StuckDetector(config.llm.handoff, {
            authenticated: role !== undefined,
            ...(role?.kind === "fields" ? { loginUrl: new URL(role.loginUrl, config.baseUrl).href } : {}),
          }),
          placeholders: new PromptPlaceholders(config, secrets),
          role: name,
          findings: () => oracles.findings.map((f) => `${f.severity} ${f.oracle}: ${f.message}`),
          ...(config.stayOnDomain ? { origin: new URL(config.baseUrl).origin } : {}),
          ...(options.llm.debugLog === undefined ? {} : { debugLog: options.llm.debugLog }),
          log,
        })
      : undefined;
  const downloadDir = join(options.outputDir, "downloads");
  try {
    const result = await runMonkey(session.context, {
      config,
      downloadDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      ...(advisor === undefined ? {} : { advisor }),
      ...(options.spectator === undefined ? {} : { spectator: options.spectator }),
      onStep: async (record) => {
        const pages = session.context.pages();
        await oracles.check(record, pages[record.result.tab] ?? pages[0]);
        if (record.skipped === true) log(`step ${record.step} skipped: ${secrets.mask(record.result.error ?? "")}`);
        else if (options.spectator !== undefined) log(secrets.mask(describeStep(record)));
        await writer?.append(record);
        await options.onStep?.(record);
      },
    });
    const raw = await oracles.finish();
    await writer?.setFindings(raw);
    const findings = raw.map((finding) => maskFinding(finding, secrets));
    log(`${secrets.mask(summarize(result))}, ${plural(findings.length, "finding")}`);
    for (const finding of findings) log(`  ${describeFinding(finding)}`);
    if (advisor !== undefined && options.llm !== undefined) log(describeUsage(options.llm.stats.role(name)));
    if (writer !== undefined) log(`actions: ${writer.file}`);
    outcome = {
      role: name,
      result,
      findings,
      blockedNavigations: session.events.length,
      ...(writer === undefined ? {} : { actionLog: writer.file }),
    };
  } finally {
    const artifacts = await session.close();
    if (!config.report.keepDownloads) await removeDownloads(downloadDir);
    if (artifacts.tracePath !== undefined) log(`trace: ${artifacts.tracePath}`);
    if (outcome !== undefined) {
      if (artifacts.tracePath !== undefined) outcome.tracePath = artifacts.tracePath;
      outcome.videoPaths = artifacts.videoPaths;
    }
  }
  return outcome;
}

/** One line per step in spectator mode, e.g. `step 12 llm: click getByRole('link', { name: 'Home' }) -> failed: …`. */
export function describeStep(record: StepRecord): string {
  const { action, locator } = record;
  // The durable locator says more than the short-lived ref.
  const text = describeAction(
    locator === undefined || !("ref" in action) ? action : ({ ...action, ref: locator } as Action),
  );
  const outcome = record.result.ok ? "" : ` -> failed: ${record.result.error ?? "unknown error"}`;
  const events = record.events === undefined ? "" : ` [${record.events.map(describeEvent).join("; ")}]`;
  return `step ${record.step} ${record.source}: ${text}${outcome}${events}`;
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
