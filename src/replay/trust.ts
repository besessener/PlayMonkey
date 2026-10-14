import type { Config } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";
import { UrlScope } from "../monkey/scope.ts";
import type { ActionLog } from "./log.ts";

/**
 * Returns the variables of `env` that a replay may fill into an action log: only those the user's own config uses.
 * An action log may come from someone else (a CI artifact of a fork), so it must not choose which variables it gets.
 */
export function replayVariables(env: NodeJS.ProcessEnv, configSecrets: Secrets | undefined): NodeJS.ProcessEnv {
  if (configSecrets === undefined) return {};
  return Object.fromEntries(configSecrets.names.map((name) => [name, env[name]]));
}

/**
 * Returns why an action log must not run against the site of `config`, or undefined. The log's `baseUrl` must be on
 * the origin of the config's, and every `navigate` must pass the same checks as one the LLM chooses.
 */
export function untrustedLogProblem(log: ActionLog, config: Config, secrets: Secrets): string | undefined {
  const base = httpUrl(log.baseUrl);
  if (base === undefined) return `baseUrl ${secrets.mask(log.baseUrl)} is not an http(s) URL`;
  const origin = new URL(config.baseUrl).origin;
  if (base.origin !== origin) {
    return `baseUrl ${secrets.mask(base.origin)} is not on the origin of the config's baseUrl ${secrets.mask(origin)}; replay only logs of runs against the site of your --config`;
  }
  const scope = new UrlScope(config.scope);
  for (const action of log.actions) {
    if (action.type !== "navigate") continue;
    const problem = navigateProblem(action.url, { base, origin: config.stayOnDomain ? origin : undefined, scope });
    if (problem !== undefined) {
      return `step ${action.step}: navigate ${secrets.mask(action.url)} ${problem}; replay refuses it, so check where the log comes from`;
    }
  }
  return undefined;
}

interface NavigateRules {
  base: URL;
  /** With `stayOnDomain`. */
  origin: string | undefined;
  scope: UrlScope;
}

/** The checks of the LLM driver for a navigation target; returns why `url` is refused, or undefined. */
function navigateProblem(url: string, { base, origin, scope }: NavigateRules) {
  const target = httpUrl(url, base);
  if (target === undefined) return "is not an http(s) URL";
  if (origin !== undefined && target.origin !== origin) return "leaves the site under test (stayOnDomain)";
  return scope.allows(target.href) ? undefined : "is outside the configured scope";
}

export function isHttpUrl(text: string): boolean {
  return httpUrl(text) !== undefined;
}

function httpUrl(text: string, base?: URL): URL | undefined {
  try {
    const url = new URL(text, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
