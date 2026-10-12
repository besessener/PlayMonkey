import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config/config.ts";
import { ExitCode } from "../exit-codes.ts";

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
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes:
  0  no findings
  1  findings present
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
  if (command === "run") return run(file, io);

  // Stub until replay (#9) lands.
  io.stderr(`monkey ${command}: not implemented yet\n`);
  return ExitCode.Error;
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

  // Stub until the run loop (#7) lands.
  io.stderr("monkey run: run loop not implemented yet\n");
  return ExitCode.Error;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
