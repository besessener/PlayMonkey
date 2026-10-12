import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config/config.ts";
import { ExitCode } from "../exit-codes.ts";
import { ActionLogError } from "../replay/log.ts";
import { ReplayError, replayActionLog } from "../replay/replay.ts";
import { describeFinding, runAllRoles } from "../run.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

const USAGE = `Usage: monkey <command> [options]

Commands:
  run <config.json>      Explore the site described by the config and report findings.
  replay <actions.json>  Re-execute a recorded action log and check which findings recur.

Options:
  -c, --config <file>    replay: config for login, browser and oracle settings
                         (needed when the log was recorded as a role that logs in).
  --strict               replay: abort when a recorded element is not found,
                         instead of skipping that action.
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes:
  0  no findings (replay: none of the recorded findings recurred)
  1  findings present (replay: at least one recorded finding recurred)
  2  tool or config error
`;

const COMMANDS: Record<string, { argName: string }> = {
  run: { argName: "config.json" },
  replay: { argName: "actions.json" },
};

function readVersion(): string {
  // Resolves to the package root both from src/cli (tests) and dist/cli (built).
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

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
  if (command === "run") {
    if (values.config !== undefined || values.strict === true) {
      io.stderr(`monkey run: --config and --strict belong to replay\n\n${USAGE}`);
      return ExitCode.Error;
    }
    return run(file, io);
  }
  return replay(file, values.config, values.strict === true, io);
}

async function run(configFile: string, io: CliIo): Promise<ExitCode> {
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(configFile, io.env === undefined ? {} : { env: io.env });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`monkey run: ${error.message}\n`);
      return ExitCode.Error;
    }
    throw error;
  }
  const { config, seedGenerated } = loaded;
  io.stdout(`seed: ${config.seed}${seedGenerated ? ' (generated; set "seed" in the config to reuse it)' : ""}\n`);

  const abort = new AbortController();
  const onSignal = () => {
    io.stderr("monkey run: stopping after the current step\n");
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  try {
    const outcomes = await runAllRoles(loaded, {
      log: (line) => io.stdout(`${line}\n`),
      signal: abort.signal,
    });
    const findings = outcomes.reduce((sum, outcome) => sum + outcome.findings.length, 0);
    io.stdout(`findings: ${findings}\n`);
    const failed = outcomes.some((outcome) => outcome.result === undefined || outcome.result.stopReason === "error");
    if (failed) return ExitCode.Error;
    return findings > 0 ? ExitCode.Findings : ExitCode.NoFindings;
  } catch (error) {
    io.stderr(`monkey run: ${loaded.secrets.mask(error instanceof Error ? error.message : String(error))}\n`);
    return ExitCode.Error;
  } finally {
    process.off("SIGINT", onSignal);
  }
}

async function replay(logFile: string, configFile: string | undefined, strict: boolean, io: CliIo): Promise<ExitCode> {
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
    },
  });
}
