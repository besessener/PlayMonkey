import { dirname, join } from "node:path";
import { launchBrowser } from "../auth/browser.ts";
import { ANONYMOUS_ROLE } from "../auth/session.ts";
import { type AuthRole, type Config, type LoadedConfig, loadConfig, parseConfig } from "../config/config.ts";
import { maskSecrets, Secrets } from "../config/secrets.ts";
import type { PlannedAction } from "../monkey/loop.ts";
import type { Spectator } from "../monkey/spectator.ts";
import { type RoleOutcome, runRole } from "../run.ts";
import {
  type ActionLog,
  ActionLogError,
  type LoggedAction,
  type LoggedFinding,
  readActionLog,
  toAction,
} from "./log.ts";
import { isHttpUrl, replayVariables, untrustedLogProblem } from "./trust.ts";

export interface ReplayOptions {
  /** Config file for login, browser and oracle settings; needed to replay a role that logs in. */
  config?: string;
  /** Abort at the first recorded element that cannot be found, instead of skipping it. */
  strict: boolean;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  signal?: AbortSignal;
  /** Spectator mode (`--watch`). */
  spectator?: Spectator;
}

export interface ReplayResult {
  outcome: RoleOutcome;
  /** The findings of the recorded run, masked, each marked reproduced or not. */
  original: (LoggedFinding & { reproduced: boolean })[];
  /** Findings of the replay that the recorded run did not have; masked. */
  added: RoleOutcome["findings"];
}

/** The replay cannot start, e.g. the role needs a login the config does not describe. Maps to exit code 2. */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/** An action log, ready to replay: its config, secrets and role. */
export interface PreparedReplay {
  /** With placeholders resolved. */
  log: ActionLog;
  loaded: Pick<LoadedConfig, "config" | "secrets" | "variables">;
  /** Undefined for the anonymous role. */
  role: AuthRole | undefined;
}

/**
 * Reads an action log and the config for its role. The recorded run decides where and at which size the actions
 * happen; the config adds login, browser and oracle settings. The log is untrusted: it gets only the variables the
 * config uses and must stay on the config's site.
 */
export async function prepareReplay(
  file: string,
  options: Pick<ReplayOptions, "config" | "env">,
): Promise<PreparedReplay> {
  const given = options.config === undefined ? undefined : await loadConfig(options.config, { env: options.env });
  const { log, secrets: logSecrets } = await readActionLog(file, replayVariables(options.env, given?.variables));
  const loaded = given ?? configFromLog(file, log);
  const config: Config = {
    ...loaded.config,
    baseUrl: log.baseUrl,
    seed: log.seed,
    browser: { ...loaded.config.browser, viewport: log.viewport },
  };
  // The log's values of the config's secrets are secrets; those of its baseUrl variables are not.
  const secretNames = new Set(loaded.secrets.names);
  const secrets = new Secrets([...loaded.secrets.entries, ...logSecrets.filter(({ name }) => secretNames.has(name))]);
  const variables = new Secrets([...loaded.variables.entries, ...logSecrets]);
  const problem = untrustedLogProblem(log, loaded.config, secrets);
  if (problem !== undefined) throw new ActionLogError(file, problem);
  const role = config.auth.find((r) => r.name === log.role);
  if (role === undefined && log.role !== ANONYMOUS_ROLE) {
    throw new ReplayError(
      options.config === undefined
        ? `the log was recorded as role "${secrets.mask(log.role)}"; pass --config with that role to log in`
        : `role "${secrets.mask(log.role)}" is not in the config's auth`,
    );
  }
  return { log, loaded: { config, secrets, variables }, role };
}

/** Default settings on the log's own site, for a replay without `--config`. */
function configFromLog(file: string, log: ActionLog): LoadedConfig {
  if (!isHttpUrl(log.baseUrl)) throw new ActionLogError(file, `baseUrl ${log.baseUrl} is not an http(s) URL`);
  return parseConfig(JSON.stringify({ baseUrl: log.baseUrl, seed: log.seed }), { env: {} });
}

/** A logged action as a step of a replay plan. */
export function toPlanned(entry: LoggedAction): PlannedAction {
  return {
    action: toAction(entry),
    source: entry.source,
    ...(entry.locator === undefined ? {} : { locator: entry.locator }),
    ...(entry.toLocator === undefined ? {} : { toLocator: entry.toLocator }),
    ...(entry.events === undefined ? {} : { events: entry.events }),
  };
}

/**
 * Re-executes a recorded action log in a fresh context for its role, without an LLM, runs the same oracles and
 * compares the findings with the recorded ones by dedup key. Output goes to `replay/` next to the log.
 */
export async function replayActionLog(file: string, options: ReplayOptions): Promise<ReplayResult> {
  const { log, loaded, role } = await prepareReplay(file, options);
  const { config, secrets } = loaded;
  const browser = await launchBrowser(
    config.browser,
    options.spectator === undefined ? {} : { spectator: options.spectator },
  );
  let outcome: RoleOutcome;
  try {
    outcome = await runRole(browser, role, loaded, {
      log: options.log,
      outputDir: join(dirname(file), "replay"),
      actionLog: false,
      replay: { strict: options.strict, actions: log.actions.map(toPlanned) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.spectator === undefined ? {} : { spectator: options.spectator }),
    });
  } finally {
    await browser.close();
  }

  const recorded = maskSecrets(log.findings, secrets);
  const found = new Set(outcome.findings.map((finding) => finding.key));
  const known = new Set(recorded.map((finding) => finding.key));
  return {
    outcome,
    original: recorded.map((finding) => ({ ...finding, reproduced: found.has(finding.key) })),
    added: outcome.findings.filter((finding) => !known.has(finding.key)),
  };
}
