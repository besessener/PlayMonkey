import { ExitCode } from "../exit-codes.ts";
import { type ShrunkFinding, shrinkActionLog } from "../replay/shrink.ts";
import { type CliIo, withStopSignal } from "./common.ts";
import { replayFailure } from "./replay.ts";

/** Replays per finding unless `--max-replays` says otherwise; with about two seconds each, a few minutes at most. */
export const DEFAULT_MAX_REPLAYS = 60;

export interface ShrinkCommand {
  logFile: string;
  configFile: string | undefined;
  finding: string | undefined;
  /** `--max-replays` as typed. */
  maxReplays: string | undefined;
  io: CliIo;
}

/** `monkey shrink`: shortens the way to each finding of an action log. */
export async function shrink(command: ShrinkCommand): Promise<ExitCode> {
  const { io } = command;
  const maxReplays = command.maxReplays === undefined ? DEFAULT_MAX_REPLAYS : Number(command.maxReplays);
  if (!(Number.isInteger(maxReplays) && maxReplays >= 2 && maxReplays <= 1000)) {
    io.stderr(`monkey shrink: --max-replays expects 2 … 1000, got ${JSON.stringify(command.maxReplays)}\n`);
    return ExitCode.Error;
  }
  return await withStopSignal("shrink", io, async (signal) => {
    try {
      const results = await shrinkActionLog(command.logFile, {
        ...(command.configFile === undefined ? {} : { config: command.configFile }),
        ...(command.finding === undefined ? {} : { finding: command.finding }),
        env: io.env ?? process.env,
        maxReplays,
        log: (line) => io.stdout(`${line}\n`),
        signal,
      });
      for (const result of results) io.stdout(`${describeResult(result)}\n`);
      return results.some((result) => result.after !== undefined) ? ExitCode.Findings : ExitCode.NoFindings;
    } catch (error) {
      return replayFailure("shrink", error, undefined, io);
    }
  });
}

/** E.g. `shrunk  F1 http5xx: 8 -> 2 actions, 11 replays`. */
function describeResult({ finding, before, after, replays, stoppedEarly }: ShrunkFinding): string {
  const early = stoppedEarly ? " (stopped early, may shrink further)" : "";
  const outcome = after === undefined ? "not reproduced" : `${before} -> ${after} actions${early}`;
  return `shrunk  ${finding.id} ${finding.oracle}: ${outcome}, ${replays} replays`;
}
