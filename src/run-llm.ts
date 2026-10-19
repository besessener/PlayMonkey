import type { Page } from "playwright";
import type { AuthRole, Config, LlmConfig } from "./config/config.ts";
import type { Secrets } from "./config/secrets.ts";
import type { DebugLog } from "./llm/debug-log.ts";
import { type LlmBreaker, LlmDriver } from "./llm/driver.ts";
import { PromptPlaceholders } from "./llm/placeholders.ts";
import type { LlmProvider } from "./llm/provider.ts";
import { type Capture, maskedScreenshot } from "./llm/screenshot.ts";
import { StuckDetector } from "./llm/stuck.ts";
import type { LlmStats } from "./llm/usage.ts";
import { VisualInspector, type VisualSignal } from "./llm/visual-inspector.ts";
import { UrlScope } from "./monkey/scope.ts";

export interface RunLlm {
  provider: LlmProvider;
  stats: LlmStats;
  debugLog?: DebugLog;
  /** Created by `runAllRoles` when absent. */
  breaker?: LlmBreaker;
}

/** What the LLM parts of one run (not a replay) need. */
export interface LlmRun {
  /** Undefined for the anonymous role. */
  role: AuthRole | undefined;
  name: string;
  /** Key for usage statistics and the debug log. */
  label: string;
  log: (line: string) => void;
  config: Config & { llm: LlmConfig };
  secrets: Secrets;
  llm: RunLlm;
  signal?: AbortSignal | undefined;
}

/** The LLM driver of a run, which takes over steps; `findings` lists the findings so far for the prompt. */
export function createAdvisor(run: LlmRun, findings: () => string[]): LlmDriver {
  const { role, name, label, log, config, secrets, llm } = run;
  const scope = new UrlScope(config.scope);
  return new LlmDriver({
    provider: llm.provider,
    config: config.llm,
    stats: llm.stats,
    detector: new StuckDetector(config.llm.handoff, {
      authenticated: role !== undefined,
      ...(role?.kind === "fields" ? { loginUrl: new URL(role.loginUrl, config.baseUrl).href } : {}),
    }),
    placeholders: new PromptPlaceholders(config, secrets, name),
    role: name,
    run: label,
    ...(llm.breaker === undefined ? {} : { breaker: llm.breaker }),
    findings,
    ...(config.stayOnDomain ? { origin: new URL(config.baseUrl).origin } : {}),
    ...(scope.restricted ? { scope } : {}),
    ...(llm.debugLog === undefined ? {} : { debugLog: llm.debugLog }),
    log,
    signal: run.signal,
    deadline: deadline(config),
    capture: capture(run),
  });
}

/** The `visual` oracle's check, or undefined when the oracle is off. */
export function createVisualCheck(run: LlmRun): ((page: Page, step: number) => Promise<VisualSignal[]>) | undefined {
  const { config, llm } = run;
  if (!config.oracles.visual) return undefined;
  const inspector = new VisualInspector({
    provider: llm.provider,
    config: config.llm,
    stats: llm.stats,
    run: run.label,
    capture: capture(run),
    origin: new URL(config.baseUrl).origin,
    log: run.log,
    debugLog: llm.debugLog,
    signal: run.signal,
    deadline: deadline(config),
  });
  return (page, step) => inspector.inspect(page, step);
}

/** Screenshots for the LLM hide every secret of the config, the API key included. */
function capture({ config, secrets }: LlmRun): (page: Page) => Promise<Capture> {
  const values = secrets.entries.map(({ value }) => value);
  return (page) => maskedScreenshot(page, { secrets: values, timeoutMs: config.monkey.actionTimeoutMs });
}

/** A little before the loop's own deadline, which only makes it stricter. */
function deadline(config: Config): number {
  return Date.now() + config.limits.maxMinutes * 60_000;
}
