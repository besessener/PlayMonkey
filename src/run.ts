import { join } from "node:path";
import { launchBrowser } from "./auth/browser.ts";
import { ANONYMOUS_ROLE, LoginError, openRoleSession } from "./auth/session.ts";
import type { LoadedConfig } from "./config/config.ts";
import { type RunResult, runMonkey, type StepRecord } from "./monkey/loop.ts";

export interface RoleOutcome {
  role: string;
  /** Absent when the role could not start (login failed). */
  result?: RunResult;
  /** Why the role could not start; masked. */
  error?: string;
  blockedNavigations: number;
}

export interface RunAllOptions {
  /** Called with a one-line message for every role start and end. */
  log: (line: string) => void;
  onStep?: (role: string, record: StepRecord) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Runs the monkey for every role (one anonymous role without `auth`) in sequence, each in its own browser context.
 * A role that cannot log in is recorded and the others still run.
 */
export async function runAllRoles(loaded: LoadedConfig, options: RunAllOptions): Promise<RoleOutcome[]> {
  const { config, secrets } = loaded;
  const browser = await launchBrowser(config.browser);
  const outcomes: RoleOutcome[] = [];
  try {
    const roles = config.auth.length > 0 ? config.auth : [undefined];
    for (const role of roles) {
      if (options.signal?.aborted) break;
      const name = role?.name ?? ANONYMOUS_ROLE;
      options.log(`[${secrets.mask(name)}] starting`);
      let session: Awaited<ReturnType<typeof openRoleSession>>;
      try {
        session = await openRoleSession(browser, role, {
          config,
          secrets,
          outputDir: join(config.report.dir, roleDirectory(name)),
        });
      } catch (error) {
        if (!(error instanceof LoginError)) throw error;
        options.log(`[${secrets.mask(name)}] ${error.message}`);
        outcomes.push({ role: name, error: error.message, blockedNavigations: 0 });
        continue;
      }
      try {
        const result = await runMonkey(session.context, {
          config,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onStep === undefined ? {} : { onStep: (record) => options.onStep?.(name, record) }),
        });
        outcomes.push({ role: name, result, blockedNavigations: session.events.length });
        options.log(`[${secrets.mask(name)}] ${summarize(result)}`);
      } finally {
        const artifacts = await session.close();
        if (artifacts.tracePath !== undefined) options.log(`[${secrets.mask(name)}] trace: ${artifacts.tracePath}`);
      }
    }
  } finally {
    await browser.close();
  }
  return outcomes;
}

/** A directory name for a role: safe characters only. */
export function roleDirectory(role: string): string {
  return role.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

function summarize(result: RunResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const stop = result.stopReason === "error" ? `error: ${result.error}` : result.stopReason;
  return `${result.steps} steps in ${seconds}s, ${result.states} states, ${result.failedActions} failed actions, stopped: ${stop}`;
}
