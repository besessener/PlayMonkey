import { ConfigError, type LlmConfig, type LoadedConfig, loadConfig } from "../config/config.ts";
import type { ExitCode } from "../exit-codes.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { RunResult } from "../monkey/loop.ts";
import type { Spectator } from "../monkey/spectator.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Replaces the provider named in the config; tests use it. */
  llmProvider?: (llm: LlmConfig, log: (line: string) => void) => LlmProvider;
  /** Replaces `process.exit` after a second stop signal; tests use it. */
  exit?: (code: number) => void;
}

/** The stop signals and the conventional exit code (128 + signal number) of a second one. */
const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/**
 * Aborts the signal passed to `body` on SIGINT, SIGTERM or SIGHUP while it runs, so the command stops after the current
 * step and still writes its results. A second stop signal exits at once, without them.
 */
export async function withStopSignal(
  command: string,
  io: CliIo,
  body: (signal: AbortSignal) => Promise<ExitCode>,
): Promise<ExitCode> {
  const abort = new AbortController();
  const onSignal = (name: keyof typeof STOP_SIGNALS) => {
    if (abort.signal.aborted) {
      io.stderr(`monkey ${command}: ${name} again: exiting without waiting for the current step\n`);
      (io.exit ?? process.exit)(STOP_SIGNALS[name]);
      return;
    }
    io.stderr(`monkey ${command}: ${name}: stopping after the current step (send it again to exit at once)\n`);
    abort.abort();
  };
  const names = Object.keys(STOP_SIGNALS) as (keyof typeof STOP_SIGNALS)[];
  for (const name of names) process.on(name, onSignal);
  try {
    return await body(abort.signal);
  } finally {
    for (const name of names) process.off(name, onSignal);
  }
}

/** False for a run that did not start, ended with an error or was interrupted: exit code 2. */
export function completed(result: RunResult | undefined): boolean {
  return result !== undefined && result.stopReason !== "error" && result.stopReason !== "aborted";
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
