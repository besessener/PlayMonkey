import { ConfigError } from "../config/config.ts";
import { ExitCode } from "../exit-codes.ts";
import type { Spectator } from "../monkey/spectator.ts";
import { ActionLogError } from "../replay/log.ts";
import { ReplayError, replayActionLog } from "../replay/replay.ts";
import { describeFinding } from "../run-text.ts";
import { type CliIo, launchHint, withStopSignal } from "./common.ts";

export interface ReplayCommand {
  logFile: string;
  configFile: string | undefined;
  strict: boolean;
  io: CliIo;
  spectator: Spectator | undefined;
}

/** `monkey replay`: re-executes an action log and says which recorded findings recurred. */
export async function replay(options: ReplayCommand): Promise<ExitCode> {
  const { io, spectator } = options;
  return await withStopSignal("replay", io, async (signal) => {
    try {
      return await replayAndReport(options, signal);
    } catch (error) {
      return replayFailure("replay", error, spectator, io);
    }
  });
}

async function replayAndReport(
  { logFile, configFile, strict, io, spectator }: ReplayCommand,
  signal: AbortSignal,
): Promise<ExitCode> {
  const { outcome, original, added } = await replayActionLog(logFile, {
    ...(configFile === undefined ? {} : { config: configFile }),
    strict,
    env: io.env ?? process.env,
    log: (line) => io.stdout(`${line}\n`),
    signal,
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
}

/** Reports expected replay errors and launch failures with a hint; rethrows anything else. */
export function replayFailure(command: string, error: unknown, spectator: Spectator | undefined, io: CliIo): ExitCode {
  if (error instanceof ConfigError || error instanceof ActionLogError || error instanceof ReplayError) {
    io.stderr(`monkey ${command}: ${error.message}\n`);
    return ExitCode.Error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (launchHint(message, spectator) !== message) {
    io.stderr(`monkey ${command}: ${launchHint(message, spectator)}\n`);
    return ExitCode.Error;
  }
  throw error;
}
