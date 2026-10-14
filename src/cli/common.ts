import { ConfigError, type LlmConfig, type LoadedConfig, loadConfig } from "../config/config.ts";
import type { ExitCode } from "../exit-codes.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { Spectator } from "../monkey/spectator.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Replaces the provider named in the config; tests use it. */
  llmProvider?: (llm: LlmConfig, log: (line: string) => void) => LlmProvider;
}

/** Aborts the signal passed to `body` on SIGINT while it runs. */
export async function withStopSignal(
  command: string,
  io: CliIo,
  body: (signal: AbortSignal) => Promise<ExitCode>,
): Promise<ExitCode> {
  const abort = new AbortController();
  const onSignal = () => {
    io.stderr(`monkey ${command}: stopping after the current step\n`);
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  try {
    return await body(abort.signal);
  } finally {
    process.off("SIGINT", onSignal);
  }
}

/** Adds a hint when a visible browser could not be opened. */
export function launchHint(message: string, spectator: Spectator | undefined): string {
  if (spectator === undefined || !/x ?server|display|headed/i.test(message)) return message;
  // Playwright appends pages of browser logs; the first line says enough.
  return `${message.split("\n")[0]}\n  hint: --watch opens a visible browser and needs a display; without one (CI, containers) run it under xvfb-run`;
}

/** Loads a config, or prints why it cannot be used and returns undefined. */
export async function load(command: string, configFile: string, io: CliIo): Promise<LoadedConfig | undefined> {
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
