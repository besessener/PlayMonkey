import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "./auth/browser.ts";
import {
  ANONYMOUS_ROLE,
  LoginError,
  openRoleSession,
  type RoleSession,
  type SessionArtifacts,
} from "./auth/session.ts";
import type { AuthRole, LoadedConfig } from "./config/config.ts";
import { DebugLog } from "./llm/debug-log.ts";
import { LlmBreaker, LlmDriver } from "./llm/driver.ts";
import { PromptPlaceholders } from "./llm/placeholders.ts";
import type { LlmProvider } from "./llm/provider.ts";
import { StuckDetector } from "./llm/stuck.ts";
import { describeUsage, type LlmStats } from "./llm/usage.ts";
import { CoverageTracker, type RunCoverage } from "./monkey/coverage.ts";
import { removeDownloads } from "./monkey/events.ts";
import { type ReplayPlan, type RunResult, runMonkey, type StepRecord } from "./monkey/loop.ts";
import { UrlScope } from "./monkey/scope.ts";
import type { Spectator } from "./monkey/spectator.ts";
import type { Finding } from "./oracles/finding.ts";
import { Oracles } from "./oracles/oracles.ts";
import { ActionLogWriter } from "./replay/log.ts";
import { type PlannedRun, planRuns } from "./run-plan.ts";
import { describeFinding, describeStep, maskFinding, plural, summarize } from "./run-text.ts";
import type { Snapshot } from "./snapshot/snapshot.ts";

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
  /** The pages the run acted on; absent when the run could not start. Not masked. */
  coverage?: RunCoverage;
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

/**
 * Runs the monkey for every role (one anonymous role without `auth`) and seed, up to `config.parallel` at a time,
 * each in its own browser context of one shared browser. A run that cannot log in or crashes is recorded and the
 * others still run. Outcomes are in `planRuns` order; a run not started because of the signal has the error
 * `not started: interrupted`.
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
  return outcomes.map((outcome, index) => outcome ?? notStarted(plans[index] as PlannedRun, options.log, secrets));
}

/** The outcome of a run the signal stopped before it started. */
function notStarted(plan: PlannedRun, log: (line: string) => void, secrets: LoadedConfig["secrets"]): RoleOutcome {
  const error = "not started: interrupted";
  log(`[${secrets.mask(plan.label)}] ${error}`);
  return { role: plan.role?.name ?? ANONYMOUS_ROLE, seed: plan.seed, error, findings: [], blockedNavigations: 0 };
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
  /** Record a trace and a video; default true. */
  artifacts?: boolean;
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
    session = await openRoleSession(browser, role, {
      config,
      secrets,
      outputDir: options.outputDir,
      ...(options.artifacts === false ? { trace: false, video: false } : {}),
    });
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

/**
 * The part of `runRole` after the login: runs the monkey or the replay, then closes the session. An error while
 * closing is logged and keeps the run's outcome.
 */
async function runSession(run: RoleRun, session: RoleSession): Promise<RoleOutcome> {
  const downloadDir = join(run.options.outputDir, "downloads");
  let outcome: RoleOutcome | undefined;
  try {
    outcome = await exploreSession(run, session, downloadDir);
  } finally {
    const artifacts = await closeSession(run, session);
    if (!run.loaded.config.report.keepDownloads) await removeDownloads(downloadDir);
    if (outcome !== undefined && artifacts !== undefined) {
      if (artifacts.tracePath !== undefined) outcome.tracePath = artifacts.tracePath;
      outcome.videoPaths = artifacts.videoPaths;
    }
  }
  return outcome;
}

/** Runs the monkey or the replay in an open session, with the oracles, the coverage and the action log. */
async function exploreSession(run: RoleRun, session: RoleSession, downloadDir: string): Promise<RoleOutcome> {
  const { name, label, log, options } = run;
  const { config } = run.loaded;
  const oracles = new Oracles(session.context, {
    config,
    role: name,
    screenshotDir: join(options.outputDir, "screenshots"),
    secrets: run.loaded.secrets,
  });
  const writer = options.actionLog ? await createActionLog(run) : undefined;
  const advisor = createAdvisor(run, oracles);
  const coverage = new CoverageTracker({
    origin: new URL(config.baseUrl).origin,
    stayOnDomain: config.stayOnDomain,
    scope: new UrlScope(config.scope),
  });
  const result = await runMonkey(session.context, {
    config,
    downloadDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(advisor === undefined ? {} : { advisor }),
    ...(options.spectator === undefined ? {} : { spectator: options.spectator }),
    onStep: stepHandler(run, session, { oracles, coverage, writer }),
  });
  const findings = await collectFindings(run, result, oracles, writer);
  if (advisor !== undefined && options.llm !== undefined) log(describeUsage(options.llm.stats.role(label)));
  if (writer !== undefined) log(`actions: ${writer.file}`);
  return {
    role: name,
    seed: config.seed,
    result,
    findings,
    blockedNavigations: session.events.length,
    ...(writer === undefined ? {} : { actionLog: writer.file }),
    coverage: coverage.summary(),
  };
}

/** Closes the session and logs the trace path; logs instead of throwing when closing fails. */
async function closeSession(run: RoleRun, session: RoleSession): Promise<SessionArtifacts | undefined> {
  try {
    const artifacts = await session.close();
    if (artifacts.tracePath !== undefined) run.log(`trace: ${artifacts.tracePath}`);
    return artifacts;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    run.log(run.loaded.secrets.mask(`closing the session failed, trace and videos may be missing: ${reason}`));
    return undefined;
  }
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
    placeholders: new PromptPlaceholders(config, secrets, name),
    role: name,
    run: label,
    ...(llm.breaker === undefined ? {} : { breaker: llm.breaker }),
    findings: () => oracles.findings.map((f) => `${f.severity} ${f.oracle}: ${f.message}`),
    ...(config.stayOnDomain ? { origin: new URL(config.baseUrl).origin } : {}),
    ...(scope.restricted ? { scope } : {}),
    ...(llm.debugLog === undefined ? {} : { debugLog: llm.debugLog }),
    log,
    signal: options.signal,
    // A little before the loop's own deadline, which only makes it stricter.
    deadline: Date.now() + config.limits.maxMinutes * 60_000,
  });
}

/** What a run's steps feed: the oracles, the coverage and the action log. */
interface StepSinks {
  oracles: Oracles;
  coverage: CoverageTracker;
  writer: ActionLogWriter | undefined;
}

/** Checks every step with the oracles, logs it when skipped or in spectator mode, and appends it to the log. */
function stepHandler(
  run: RoleRun,
  session: RoleSession,
  { oracles, coverage, writer }: StepSinks,
): (record: StepRecord, snapshot: Snapshot) => Promise<void> {
  const { log, options } = run;
  const { secrets } = run.loaded;
  return async (record, snapshot) => {
    coverage.record(record, snapshot);
    const pages = session.context.pages();
    await oracles.check(record, pages[record.result.tab] ?? pages[0]);
    if (record.skipped === true) log(`step ${record.step} skipped: ${secrets.mask(record.result.error ?? "")}`);
    else if (options.spectator !== undefined) log(describeStep(record, secrets));
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
