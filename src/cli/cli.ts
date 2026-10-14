import { parseArgs } from "node:util";
import type { LoadedConfig } from "../config/config.ts";
import { ExitCode } from "../exit-codes.ts";
import { createProvider } from "../llm/factory.ts";
import { runPreflight } from "../llm/preflight.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { describeUsage, LlmStats } from "../llm/usage.ts";
import { DEFAULT_SPECTATOR, type Spectator } from "../monkey/spectator.ts";
import { SEVERITIES } from "../oracles/finding.ts";
import { type Baseline, BaselineError, readBaseline } from "../report/baseline.ts";
import { buildReport, type Report, writeReport } from "../report/report.ts";
import { type RoleOutcome, type RunLlm, runAllRoles } from "../run.ts";
import { planRuns } from "../run-plan.ts";
import { readVersion } from "../version.ts";
import { type CliIo, completed, launchHint, load, withStopSignal } from "./common.ts";
import { replay } from "./replay.ts";
import { DEFAULT_MAX_REPLAYS, shrink } from "./shrink.ts";

const USAGE = `Usage: monkey <command> [options]

Commands:
  run <config.json>        Explore the site described by the config and report findings.
  replay <actions.json>    Re-execute a recorded action log and check which findings recur.
  preflight <config.json>  Check that the configured LLM endpoint works, without a browser.
  shrink <actions.json>    Shorten the way to each finding of an action log to the fewest
                           actions that still reproduce it, by replaying parts of it.

Options:
  -c, --config <file>    replay, shrink: config for login, browser and oracle settings
                         (needed when the log was recorded as a role that logs in).
  --strict               replay: abort when a recorded element is not found,
                         instead of skipping that action.
  --finding <id>         shrink: only this finding, e.g. F2 (default: all of the log).
  --max-replays <n>      shrink: replays per finding, 2 … 1000 (default ${DEFAULT_MAX_REPLAYS}).
  -w, --watch            run, replay: spectator mode for watching or demos. Opens a
                         visible browser, slows it down, outlines each element
                         before acting on it and prints every step.
  --slow-mo <ms>         run, replay: delay per browser operation in spectator mode
                         (default ${DEFAULT_SPECTATOR.slowMoMs}; 0 for full speed). Implies --watch.
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes:
  0  no findings (with findings.baseline: no new ones; replay: none of the recorded
     findings recurred; shrink: none reproduced)
  1  findings present (with findings.baseline: new ones; replay: at least one
     recorded finding recurred; shrink: at least one reproduced and shortened)
  2  tool or config error (also: the LLM preflight failed with llm.required, or a
     run did not complete, e.g. interrupted; takes precedence over 1)

Ctrl+C, SIGTERM or SIGHUP stop after the current step and still write the report;
a second one exits at once without it.
`;

const COMMANDS: Record<string, { argName: string }> = {
  run: { argName: "config.json" },
  replay: { argName: "actions.json" },
  preflight: { argName: "config.json" },
  shrink: { argName: "actions.json" },
};

/** The commands each option belongs to; `--help` and `--version` go with any. */
const OPTION_COMMANDS: Record<string, string[]> = {
  config: ["replay", "shrink"],
  strict: ["replay"],
  watch: ["run", "replay"],
  "slow-mo": ["run", "replay"],
  finding: ["shrink"],
  "max-replays": ["shrink"],
};

type Parsed = ReturnType<typeof parse>;

/** A command line that passed validation and is ready to dispatch. */
interface Invocation {
  command: string;
  file: string;
  values: Parsed["values"];
  spectator: Spectator | undefined;
}

/** Parses `argv` (without the node and script paths), runs the command and returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<ExitCode> {
  const invocation = resolveInvocation(argv, io);
  if (typeof invocation === "number") return invocation;
  return await dispatch(invocation, io);
}

/** Handles parse errors, `--version` and `--help`; returns the invocation to run or the exit code. */
function resolveInvocation(argv: string[], io: CliIo): Invocation | ExitCode {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(io, "monkey", (error as Error).message);
  }
  if (parsed.values.version) {
    io.stdout(`${readVersion()}\n`);
    return ExitCode.NoFindings;
  }
  if (parsed.values.help) {
    io.stdout(USAGE);
    return ExitCode.NoFindings;
  }
  return checkInvocation(parsed, io);
}

/** Validates the command, its argument and which options it may take. */
function checkInvocation({ values, positionals }: Parsed, io: CliIo): Invocation | ExitCode {
  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, "monkey", "missing command");
  const spec = COMMANDS[command];
  if (spec === undefined) return usageError(io, "monkey", `unknown command '${command}'`);
  if (rest.length !== 1) {
    return usageError(io, `monkey ${command}`, `expected exactly one <${spec.argName}> argument`);
  }
  const [file] = rest as [string];
  const misplaced = Object.keys(values).find((name) => !(OPTION_COMMANDS[name]?.includes(command) ?? true));
  if (misplaced !== undefined) {
    const owners = (OPTION_COMMANDS[misplaced] ?? []).join(" and ");
    return usageError(io, `monkey ${command}`, `--${misplaced} belongs to ${owners}`);
  }
  const spectator = spectatorOf(values);
  if (typeof spectator === "string") return usageError(io, `monkey ${command}`, spectator);
  return { command, file, values, spectator };
}

function usageError(io: CliIo, prefix: string, message: string): ExitCode {
  io.stderr(`${prefix}: ${message}\n\n${USAGE}`);
  return ExitCode.Error;
}

function dispatch({ command, file, values, spectator }: Invocation, io: CliIo): Promise<ExitCode> {
  if (command === "run") return run(file, io, spectator);
  if (command === "preflight") return preflight(file, io);
  if (command === "shrink") {
    return shrink({
      logFile: file,
      configFile: values.config,
      finding: values.finding,
      maxReplays: values["max-replays"],
      io,
    });
  }
  return replay({ logFile: file, configFile: values.config, strict: values.strict === true, io, spectator });
}

/** The spectator settings from `--watch` and `--slow-mo`, undefined without them, or a usage error. */
function spectatorOf(values: { watch?: boolean; "slow-mo"?: string }): Spectator | string | undefined {
  const raw = values["slow-mo"];
  if (raw === undefined) return values.watch === true ? { ...DEFAULT_SPECTATOR } : undefined;
  if (!/^\d{1,5}$/.test(raw)) return `--slow-mo expects milliseconds (0 … 99999), got ${JSON.stringify(raw)}`;
  const slowMoMs = Number(raw);
  // The outline lasts two operations, but at least a glance; none at full speed.
  return { slowMoMs, highlightMs: slowMoMs === 0 ? 0 : Math.max(300, 2 * slowMoMs) };
}

/**
 * Creates the provider and runs its preflight. Returns the LLM for the run, `undefined` without `llm` or when a
 * failed preflight is allowed (`llm.required: false`), or an exit code when the run must not start.
 */
async function startLlm(command: string, loaded: LoadedConfig, io: CliIo): Promise<RunLlm | ExitCode | undefined> {
  const { config, secrets } = loaded;
  const llm = config.llm;
  if (llm === undefined) return undefined;
  const log = (line: string) => io.stdout(`${secrets.mask(line)}\n`);
  const provider: LlmProvider = io.llmProvider === undefined ? createProvider(llm, log) : io.llmProvider(llm, log);
  const stats = new LlmStats(llm, provider.name);
  const { result, message } = await runPreflight(provider, llm, secrets);
  if (result.ok) {
    stats.setPreflight({ ok: true, latencyMs: result.latencyMs });
    log(message);
    return { provider, stats };
  }
  stats.setPreflight({ ok: false, error: secrets.mask(`${result.error.kind}: ${result.error.message}`) });
  if (llm.required) {
    io.stderr(`monkey ${command}: ${message}\n`);
    return ExitCode.Error;
  }
  io.stderr(`monkey ${command}: warning: ${message}\n  llm.required is false: continuing as pure random monkey\n`);
  stats.disable(`preflight failed (${result.error.kind})`);
  return { provider, stats };
}

async function preflight(configFile: string, io: CliIo): Promise<ExitCode> {
  const loaded = await load("preflight", configFile, io);
  if (loaded === undefined) return ExitCode.Error;
  if (loaded.config.llm === undefined) {
    io.stderr("monkey preflight: the config has no llm section; nothing to check\n");
    return ExitCode.Error;
  }
  // Even with llm.required false: the point of this command is the verdict.
  const started = await startLlm(
    "preflight",
    { ...loaded, config: { ...loaded.config, llm: { ...loaded.config.llm, required: true } } },
    io,
  );
  return typeof started === "object" ? ExitCode.NoFindings : ExitCode.Error;
}

async function run(configFile: string, io: CliIo, spectator?: Spectator): Promise<ExitCode> {
  const loaded = await load("run", configFile, io);
  if (loaded === undefined) return ExitCode.Error;
  printRunPlan(loaded, io);
  // Before any browser work, so a missing baseline or a broken endpoint fails fast.
  const baseline = await configuredBaseline(loaded, io);
  if (typeof baseline === "number") return baseline;
  const llm = await startLlm("run", loaded, io);
  if (typeof llm === "number") return llm;

  return await withStopSignal("run", io, async (signal) => {
    try {
      return await runAndReport({ loaded, llm, spectator, io, baseline }, signal);
    } catch (error) {
      const message = loaded.secrets.mask(error instanceof Error ? error.message : String(error));
      io.stderr(`monkey run: ${launchHint(message, spectator)}\n`);
      return ExitCode.Error;
    }
  });
}

function printRunPlan({ config, seedGenerated }: LoadedConfig, io: CliIo): void {
  if (config.seeds === undefined) {
    io.stdout(`seed: ${config.seed}${seedGenerated ? ' (generated; set "seed" in the config to reuse it)' : ""}\n`);
  } else {
    io.stdout(`seeds: ${config.seeds.join(", ")}\n`);
  }
  const runs = planRuns(config).length;
  if (runs > 1) io.stdout(`runs: ${runs}, ${Math.min(config.parallel, runs)} at a time\n`);
}

/** The baseline of `findings.baseline`, undefined without one, or exit code 2 when it cannot be read. */
async function configuredBaseline({ config }: LoadedConfig, io: CliIo): Promise<Baseline | ExitCode | undefined> {
  const file = config.findings.baseline;
  if (file === undefined) return undefined;
  try {
    return await readBaseline(file);
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error;
    io.stderr(`monkey run: ${error.message}\n`);
    return ExitCode.Error;
  }
}

interface RunContext {
  loaded: LoadedConfig;
  llm: RunLlm | undefined;
  spectator: Spectator | undefined;
  io: CliIo;
  baseline: Baseline | undefined;
}

async function runAndReport(
  { loaded, llm, spectator, io, baseline }: RunContext,
  signal: AbortSignal,
): Promise<ExitCode> {
  const startedAt = new Date();
  const outcomes = await runAllRoles(loaded, {
    log: (line) => io.stdout(`${line}\n`),
    signal,
    ...(llm === undefined ? {} : { llm }),
    ...(spectator === undefined ? {} : { spectator }),
  });
  const report = buildReport({
    loaded,
    outcomes,
    version: readVersion(),
    startedAt,
    finishedAt: new Date(),
    ...(llm === undefined ? {} : { llm: llm.stats.report() }),
    ...(baseline === undefined ? {} : { baseline }),
  });
  const paths = await writeReport(report, loaded.config.report.dir);

  printLlmUsage(report, io);
  printSummary(report, io);
  io.stdout(`report: ${paths.html}\n`);
  return runExitCode(report, incompleteRuns(outcomes, loaded), io);
}

/** The findings, the comparison with the baseline and the coverage, one line each. */
function printSummary(report: Report, io: CliIo): void {
  const total = report.aggregated.length;
  const counts = SEVERITIES.filter((severity) => report.counts[severity] > 0)
    .map((severity) => `${report.counts[severity]} ${severity}`)
    .join(", ");
  io.stdout(`findings: ${total}${total === 0 ? "" : ` (${counts})`}\n`);
  const { baseline } = report;
  if (baseline !== undefined) {
    io.stdout(`baseline: ${baseline.new} new, ${baseline.known} known, ${baseline.unseen.length} not seen this time\n`);
  }
  const { pages, unvisited } = report.coverage;
  io.stdout(`coverage: ${pages.length} pages visited, ${unvisited.length} linked pages never visited\n`);
}

function printLlmUsage({ llm }: Report, io: CliIo): void {
  if (llm === undefined) return;
  io.stdout(`${describeUsage(llm.total)}${llm.status === "disabled" ? " (disabled)" : ""}\n`);
  const exhausted = llm.budget.exhausted;
  if (exhausted !== undefined) {
    io.stdout(`llm budget exhausted at step ${exhausted.step} of role ${exhausted.role}: ${exhausted.reason}\n`);
  }
}

/** Masked labels of the runs that did not complete: not started, crashed, ended by an error or interrupted. */
function incompleteRuns(outcomes: RoleOutcome[], { config, secrets }: LoadedConfig): string[] {
  return outcomes
    .filter((outcome) => !completed(outcome.result))
    .map((outcome) => secrets.mask(config.seeds === undefined ? outcome.role : `${outcome.role}/${outcome.seed}`));
}

/** With a baseline, only new findings fail the run. */
function runExitCode(report: Report, incomplete: string[], io: CliIo): ExitCode {
  // Precedence: a run that did not complete (2) outranks findings (1).
  if (incomplete.length > 0) {
    io.stdout(`exit 2: ${incomplete.length === 1 ? "run" : "runs"} ${incomplete.join(", ")} did not complete\n`);
    return ExitCode.Error;
  }
  const findings = report.baseline?.new ?? report.aggregated.length;
  const kind = report.baseline === undefined ? "" : "new ";
  io.stdout(findings > 0 ? `exit 1: ${kind}findings present\n` : `exit 0: no ${kind}findings\n`);
  return findings > 0 ? ExitCode.Findings : ExitCode.NoFindings;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      config: { type: "string", short: "c" },
      strict: { type: "boolean" },
      watch: { type: "boolean", short: "w" },
      "slow-mo": { type: "string" },
      finding: { type: "string" },
      "max-replays": { type: "string" },
    },
  });
}
