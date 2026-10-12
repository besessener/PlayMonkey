import { parseArgs } from "node:util";
import { ConfigError, type LlmConfig, type LoadedConfig, loadConfig } from "../config/config.ts";
import { ExitCode } from "../exit-codes.ts";
import { createProvider } from "../llm/factory.ts";
import { runPreflight } from "../llm/preflight.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { describeUsage, LlmStats } from "../llm/usage.ts";
import { DEFAULT_SPECTATOR, type Spectator } from "../monkey/spectator.ts";
import { SEVERITIES } from "../oracles/finding.ts";
import { ActionLogError } from "../replay/log.ts";
import { ReplayError, replayActionLog } from "../replay/replay.ts";
import { buildReport, writeReport } from "../report/report.ts";
import { describeFinding, type RunLlm, runAllRoles } from "../run.ts";
import { readVersion } from "../version.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Replaces the provider named in the config; tests use it. */
  llmProvider?: (llm: LlmConfig, log: (line: string) => void) => LlmProvider;
}

const USAGE = `Usage: monkey <command> [options]

Commands:
  run <config.json>        Explore the site described by the config and report findings.
  replay <actions.json>    Re-execute a recorded action log and check which findings recur.
  preflight <config.json>  Check that the configured LLM endpoint works, without a browser.

Options:
  -c, --config <file>    replay: config for login, browser and oracle settings
                         (needed when the log was recorded as a role that logs in).
  --strict               replay: abort when a recorded element is not found,
                         instead of skipping that action.
  -w, --watch            run, replay: spectator mode for watching or demos. Opens a
                         visible browser, slows it down, outlines each element
                         before acting on it and prints every step.
  --slow-mo <ms>         run, replay: delay per browser operation in spectator mode
                         (default ${DEFAULT_SPECTATOR.slowMoMs}; 0 for full speed). Implies --watch.
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes:
  0  no findings (replay: none of the recorded findings recurred)
  1  findings present (replay: at least one recorded finding recurred)
  2  tool or config error (also: the LLM preflight failed with llm.required)
`;

const COMMANDS: Record<string, { argName: string }> = {
  run: { argName: "config.json" },
  replay: { argName: "actions.json" },
  preflight: { argName: "config.json" },
};

/** Parses `argv` (without the node and script paths), runs the command and returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<ExitCode> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`monkey: ${(error as Error).message}\n\n${USAGE}`);
    return ExitCode.Error;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    io.stdout(`${readVersion()}\n`);
    return ExitCode.NoFindings;
  }
  if (values.help) {
    io.stdout(USAGE);
    return ExitCode.NoFindings;
  }
  if (command === undefined) {
    io.stderr(`monkey: missing command\n\n${USAGE}`);
    return ExitCode.Error;
  }
  const spec = COMMANDS[command];
  if (spec === undefined) {
    io.stderr(`monkey: unknown command '${command}'\n\n${USAGE}`);
    return ExitCode.Error;
  }
  if (rest.length !== 1) {
    io.stderr(`monkey ${command}: expected exactly one <${spec.argName}> argument\n\n${USAGE}`);
    return ExitCode.Error;
  }

  const [file] = rest as [string];
  const spectator = spectatorOf(values);
  if (typeof spectator === "string") {
    io.stderr(`monkey ${command}: ${spectator}\n\n${USAGE}`);
    return ExitCode.Error;
  }
  if (command === "preflight" && spectator !== undefined) {
    io.stderr(`monkey preflight: --watch and --slow-mo belong to run and replay\n\n${USAGE}`);
    return ExitCode.Error;
  }
  if (command === "run" || command === "preflight") {
    if (values.config !== undefined || values.strict === true) {
      io.stderr(`monkey ${command}: --config and --strict belong to replay\n\n${USAGE}`);
      return ExitCode.Error;
    }
    return command === "run" ? run(file, io, spectator) : preflight(file, io);
  }
  return replay(file, values.config, values.strict === true, io, spectator);
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

/** Adds a hint when a visible browser could not be opened. */
function launchHint(message: string, spectator: Spectator | undefined): string {
  if (spectator === undefined || !/x ?server|display|headed/i.test(message)) return message;
  // Playwright appends pages of browser logs; the first line says enough.
  return `${message.split("\n")[0]}\n  hint: --watch opens a visible browser and needs a display; without one (CI, containers) run it under xvfb-run`;
}

async function load(command: string, configFile: string, io: CliIo): Promise<LoadedConfig | undefined> {
  try {
    return await loadConfig(configFile, io.env === undefined ? {} : { env: io.env });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`monkey ${command}: ${error.message}\n`);
      return undefined;
    }
    throw error;
  }
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
  const { config, seedGenerated } = loaded;
  io.stdout(`seed: ${config.seed}${seedGenerated ? ' (generated; set "seed" in the config to reuse it)' : ""}\n`);
  // Before any browser work, so a broken endpoint fails fast.
  const llm = await startLlm("run", loaded, io);
  if (typeof llm === "number") return llm;

  const abort = new AbortController();
  const onSignal = () => {
    io.stderr("monkey run: stopping after the current step\n");
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  try {
    const startedAt = new Date();
    const outcomes = await runAllRoles(loaded, {
      log: (line) => io.stdout(`${line}\n`),
      signal: abort.signal,
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
    });
    const paths = await writeReport(report, config.report.dir);

    if (report.llm !== undefined) {
      io.stdout(`${describeUsage(report.llm.total)}${report.llm.status === "disabled" ? " (disabled)" : ""}\n`);
      const exhausted = report.llm.budget.exhausted;
      if (exhausted !== undefined) {
        io.stdout(`llm budget exhausted at step ${exhausted.step} of role ${exhausted.role}: ${exhausted.reason}\n`);
      }
    }

    const total = report.findings.length;
    const counts = SEVERITIES.filter((severity) => report.counts[severity] > 0)
      .map((severity) => `${report.counts[severity]} ${severity}`)
      .join(", ");
    io.stdout(`findings: ${total}${total === 0 ? "" : ` (${counts})`}\n`);
    io.stdout(`report: ${paths.html}\n`);
    const failed = outcomes.filter((outcome) => outcome.result === undefined || outcome.result.stopReason === "error");
    if (failed.length > 0) {
      const roles = failed.map((outcome) => loaded.secrets.mask(outcome.role)).join(", ");
      io.stdout(`exit 2: ${failed.length === 1 ? "role" : "roles"} ${roles} did not complete\n`);
      return ExitCode.Error;
    }
    io.stdout(total > 0 ? "exit 1: findings present\n" : "exit 0: no findings\n");
    return total > 0 ? ExitCode.Findings : ExitCode.NoFindings;
  } catch (error) {
    const message = loaded.secrets.mask(error instanceof Error ? error.message : String(error));
    io.stderr(`monkey run: ${launchHint(message, spectator)}\n`);
    return ExitCode.Error;
  } finally {
    process.off("SIGINT", onSignal);
  }
}

async function replay(
  logFile: string,
  configFile: string | undefined,
  strict: boolean,
  io: CliIo,
  spectator?: Spectator,
): Promise<ExitCode> {
  const abort = new AbortController();
  const onSignal = () => {
    io.stderr("monkey replay: stopping after the current step\n");
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  try {
    const { outcome, original, added } = await replayActionLog(logFile, {
      ...(configFile === undefined ? {} : { config: configFile }),
      strict,
      env: io.env ?? process.env,
      log: (line) => io.stdout(`${line}\n`),
      signal: abort.signal,
      ...(spectator === undefined ? {} : { spectator }),
    });
    if (outcome.result === undefined || outcome.result.stopReason === "error") return ExitCode.Error;
    for (const finding of original) {
      const verdict = finding.reproduced ? "reproduced    " : "not reproduced";
      io.stdout(`${verdict}  ${finding.id} ${finding.severity} ${finding.oracle}: ${finding.message}\n`);
    }
    for (const finding of added) io.stdout(`new             ${describeFinding(finding)}\n`);
    const reproduced = original.filter((finding) => finding.reproduced).length;
    io.stdout(`reproduced: ${reproduced} of ${original.length}\n`);
    return reproduced > 0 ? ExitCode.Findings : ExitCode.NoFindings;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ActionLogError || error instanceof ReplayError) {
      io.stderr(`monkey replay: ${error.message}\n`);
      return ExitCode.Error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (launchHint(message, spectator) !== message) {
      io.stderr(`monkey replay: ${launchHint(message, spectator)}\n`);
      return ExitCode.Error;
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
  }
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
    },
  });
}
