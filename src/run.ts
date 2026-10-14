import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "./auth/browser.ts";
import { ANONYMOUS_ROLE, LoginError, openRoleSession, type RoleSession } from "./auth/session.ts";
import type { AuthRole, LoadedConfig } from "./config/config.ts";
import { maskSecrets, type Secrets } from "./config/secrets.ts";
import { DebugLog } from "./llm/debug-log.ts";
import { LlmBreaker, LlmDriver } from "./llm/driver.ts";
import { PromptPlaceholders } from "./llm/placeholders.ts";
import type { LlmProvider } from "./llm/provider.ts";
import { StuckDetector } from "./llm/stuck.ts";
import { describeUsage, type LlmStats } from "./llm/usage.ts";
import { type Action, describeAction } from "./monkey/actions.ts";
import { describeEvent, removeDownloads } from "./monkey/events.ts";
import { type ReplayPlan, type RunResult, runMonkey, type StepRecord } from "./monkey/loop.ts";
import { UrlScope } from "./monkey/scope.ts";
import type { Spectator } from "./monkey/spectator.ts";
import type { Finding } from "./oracles/finding.ts";
import { Oracles } from "./oracles/oracles.ts";
import { ActionLogWriter } from "./replay/log.ts";

export interface RoleOutcome {
  role: string;
  /** The seed of this run. */
  seed: number;
  /** Absent when the run could not start (login failed) or crashed. */
  result?: RunResult;
  /** Why the run could not start or crashed; masked. */
  error?: string;
  /** Deduplicated, in order of discovery; masked. Empty when the run could not start. */
  findings: Finding[];
  blockedNavigations: number;
  /** The run's `actions.json`, when one was written. */
  actionLog?: string;
  /** Playwright trace and videos of the run's context; absent when the run could not start. */
  tracePath?: string;
  videoPaths?: string[];
}

export interface RunAllOptions {
  /** Called with a one-line message for every run start and end. */
  log: (line: string) => void;
  onStep?: (role: string, record: StepRecord, seed: number) => void | Promise<void>;
  signal?: AbortSignal;
  /** The LLM for stuck situations; shared by all runs, like its budget and circuit breaker. Requires `config.llm`. */
  llm?: RunLlm;
  /** Spectator mode (`--watch`): visible, slowed-down browser and one console line per step. */
  spectator?: Spectator;
}

export interface RunLlm {
  provider: LlmProvider;
  stats: LlmStats;
  debugLog?: DebugLog;
  /** Created by `runAllRoles` when absent. */
  breaker?: LlmBreaker;
}

/** One run of an invocation: a role (undefined: anonymous) with a seed. */
export interface PlannedRun {
  role: AuthRole | undefined;
  seed: number;
  /** `role`, or `role/seed` with `seeds`; prefixes log lines and keys LLM usage. */
  label: string;
  /** `<report.dir>/<role>`, or `<report.dir>/<role>/<seed>` with `seeds`. */
  outputDir: string;
}

/** Every run of the config, roles first, then seeds: the order of the report, whatever order they finish in. */
export function planRuns(config: LoadedConfig["config"]): PlannedRun[] {
  const roles = config.auth.length > 0 ? config.auth : [undefined];
  return roles.flatMap((role) => {
    const name = role?.name ?? ANONYMOUS_ROLE;
    const roleDir = join(config.report.dir, roleDirectory(name));
    if (config.seeds === undefined) return [{ role, seed: config.seed, label: name, outputDir: roleDir }];
    return config.seeds.map((seed) => ({
      role,
      seed,
      label: `${name}/${seed}`,
      outputDir: join(roleDir, String(seed)),
    }));
  });
}

/**
 * Runs the monkey for every role (one anonymous role without `auth`) and seed, up to `config.parallel` at a time,
 * each in its own browser context of one shared browser. A run that cannot log in or crashes is recorded and the
 * others still run. Outcomes are in `planRuns` order; runs not started because of the signal are left out.
 */
export async function runAllRoles(loaded: LoadedConfig, options: RunAllOptions): Promise<RoleOutcome[]> {
  const { config, secrets } = loaded;
  let llm = options.llm;
  if (llm !== undefined && config.llm?.debugLog === true && llm.debugLog === undefined) {
    const file = join(config.report.dir, "llm-debug.jsonl");
    await rm(file, { force: true });
    llm = { ...llm, debugLog: new DebugLog(file, loaded.secrets) };
  }
  if (llm !== undefined && llm.breaker === undefined) llm = { ...llm, breaker: new LlmBreaker() };
  const browser = await launchBrowser(
    config.browser,
    options.spectator === undefined ? {} : { spectator: options.spectator },
  );
  const plans = planRuns(config);
  const outcomes: (RoleOutcome | undefined)[] = plans.map(() => undefined);
  let next = 0;
  const worker = async () => {
    while (next < plans.length && options.signal?.aborted !== true) {
      const index = next++;
      const plan = plans[index] as PlannedRun;
      const name = plan.role?.name ?? ANONYMOUS_ROLE;
      try {
        outcomes[index] = await runRole(
          browser,
          plan.role,
          { config: { ...config, seed: plan.seed }, secrets },
          plannedRoleOptions(plan, options, llm),
        );
      } catch (error) {
        // One crashed run must not take the others down.
        const message = secrets.mask(
          `crashed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
        options.log(`[${secrets.mask(plan.label)}] ${message}`);
        outcomes[index] = { role: name, seed: plan.seed, error: message, findings: [], blockedNavigations: 0 };
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(config.parallel, plans.length) }, worker));
  } finally {
    await browser.close();
  }
  return outcomes.filter((outcome) => outcome !== undefined);
}

/** The options `runAllRoles` gives `runRole` for one planned run. */
function plannedRoleOptions(plan: PlannedRun, options: RunAllOptions, llm: RunLlm | undefined): RoleOptions {
  const name = plan.role?.name ?? ANONYMOUS_ROLE;
  return {
    log: options.log,
    label: plan.label,
    outputDir: plan.outputDir,
    actionLog: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onStep === undefined ? {} : { onStep: (record) => options.onStep?.(name, record, plan.seed) }),
    ...(llm === undefined ? {} : { llm }),
    ...(options.spectator === undefined ? {} : { spectator: options.spectator }),
  };
}

export interface RoleOptions {
  log: (line: string) => void;
  /** Log prefix and LLM usage key; default: the role name. */
  label?: string;
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
  const label = options.label ?? name;
  const log = (line: string) => options.log(`[${secrets.mask(label)}] ${line}`);
  log(options.replay === undefined ? "starting" : `replaying ${plural(options.replay.actions.length, "action")}`);
  let session: RoleSession;
  try {
    session = await openRoleSession(browser, role, { config, secrets, outputDir: options.outputDir });
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    log(error.message);
    return { role: name, seed: config.seed, error: error.message, findings: [], blockedNavigations: 0 };
  }
  return await runSession({ role, name, label, log, loaded, options }, session);
}

/** One call of `runRole`: its arguments, the role's name, the log label and the labelled log. */
interface RoleRun {
  role: AuthRole | undefined;
  name: string;
  label: string;
  log: (line: string) => void;
  loaded: Pick<LoadedConfig, "config" | "secrets">;
  options: RoleOptions;
}

/** The part of `runRole` after the login: runs the monkey or the replay, then closes the session. */
async function runSession(run: RoleRun, session: RoleSession): Promise<RoleOutcome> {
  const { name, label, log, options } = run;
  const { config } = run.loaded;
  const oracles = new Oracles(session.context, {
    config,
    role: name,
    screenshotDir: join(options.outputDir, "screenshots"),
  });
  const writer = options.actionLog ? await createActionLog(run) : undefined;
  const advisor = createAdvisor(run, oracles);
  const downloadDir = join(options.outputDir, "downloads");
  let outcome: RoleOutcome | undefined;
  try {
    const result = await runMonkey(session.context, {
      config,
      downloadDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      ...(advisor === undefined ? {} : { advisor }),
      ...(options.spectator === undefined ? {} : { spectator: options.spectator }),
      onStep: stepHandler(run, session, oracles, writer),
    });
    const findings = await collectFindings(run, result, oracles, writer);
    if (advisor !== undefined && options.llm !== undefined) log(describeUsage(options.llm.stats.role(label)));
    if (writer !== undefined) log(`actions: ${writer.file}`);
    outcome = {
      role: name,
      seed: config.seed,
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

/** Writes `actions.json` of one run into its output directory. */
async function createActionLog(run: RoleRun): Promise<ActionLogWriter> {
  const { config, secrets } = run.loaded;
  await mkdir(run.options.outputDir, { recursive: true });
  return new ActionLogWriter(
    join(run.options.outputDir, "actions.json"),
    { seed: config.seed, baseUrl: config.baseUrl, role: run.name, viewport: config.browser.viewport },
    secrets,
  );
}

/** The LLM driver of a run; none for a replay or without an LLM. */
function createAdvisor(run: RoleRun, oracles: Oracles): LlmDriver | undefined {
  const { role, name, label, log, options } = run;
  const { config, secrets } = run.loaded;
  const llm = options.llm;
  if (options.replay !== undefined || llm === undefined || config.llm === undefined) return undefined;
  const scope = new UrlScope(config.scope);
  return new LlmDriver({
    provider: llm.provider,
    config: config.llm,
    stats: llm.stats,
    detector: new StuckDetector(config.llm.handoff, {
      authenticated: role !== undefined,
      ...(role?.kind === "fields" ? { loginUrl: new URL(role.loginUrl, config.baseUrl).href } : {}),
    }),
    placeholders: new PromptPlaceholders(config, secrets),
    role: name,
    run: label,
    ...(llm.breaker === undefined ? {} : { breaker: llm.breaker }),
    findings: () => oracles.findings.map((f) => `${f.severity} ${f.oracle}: ${f.message}`),
    ...(config.stayOnDomain ? { origin: new URL(config.baseUrl).origin } : {}),
    ...(scope.restricted ? { scope } : {}),
    ...(llm.debugLog === undefined ? {} : { debugLog: llm.debugLog }),
    log,
  });
}

/** Checks every step with the oracles, logs it when skipped or in spectator mode, and appends it to the log. */
function stepHandler(
  run: RoleRun,
  session: RoleSession,
  oracles: Oracles,
  writer: ActionLogWriter | undefined,
): (record: StepRecord) => Promise<void> {
  const { log, options } = run;
  const { secrets } = run.loaded;
  return async (record) => {
    const pages = session.context.pages();
    await oracles.check(record, pages[record.result.tab] ?? pages[0]);
    if (record.skipped === true) log(`step ${record.step} skipped: ${secrets.mask(record.result.error ?? "")}`);
    else if (options.spectator !== undefined) log(secrets.mask(describeStep(record)));
    await writer?.append(record);
    await options.onStep?.(record);
  };
}

/** Masks the findings of a finished run, stores them in its action log and logs the run's summary. */
async function collectFindings(
  run: RoleRun,
  result: RunResult,
  oracles: Oracles,
  writer: ActionLogWriter | undefined,
): Promise<Finding[]> {
  const { secrets } = run.loaded;
  const raw = await oracles.finish();
  await writer?.setFindings(raw);
  const findings = raw.map((finding) => maskFinding(finding, secrets));
  run.log(`${secrets.mask(summarize(result))}, ${plural(findings.length, "finding")}`);
  for (const finding of findings) run.log(`  ${describeFinding(finding)}`);
  return findings;
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
