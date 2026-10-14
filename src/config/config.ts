import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULTS } from "./defaults.ts";
import type { RawHandoff, RawLlm } from "./llm-schema.ts";
import { formatPath, type PathSegment } from "./path.ts";
import { resolvePlaceholders } from "./placeholders.ts";
import type { RawAuth, RawConfig } from "./schema.ts";
import { Secrets } from "./secrets.ts";
import { findIssues, type Issue } from "./validate.ts";
import {
  ACTION_TYPES,
  type ActionType,
  type EffortLevel,
  type Engine,
  type LlmProvider,
  MAX_SEED,
  type OpenAiApi,
  ORACLES,
  type OracleName,
  type ThinkingType,
} from "./values.ts";

/** The validated config with all defaults applied and relative paths resolved against the config file. */
export interface Config {
  baseUrl: string;
  /** With `seeds`, the first of them. */
  seed: number;
  /** Present only when configured: one run per seed and role, each in `<role>/<seed>/`. */
  seeds?: number[];
  parallel: number;
  limits: { maxSteps: number; maxMinutes: number };
  browser: { engine: Engine; viewport: [number, number]; headless: boolean };
  stayOnDomain: boolean;
  /** Regular expressions; an empty `allow` allows every URL. */
  scope: { allow: string[]; deny: string[] };
  network: { latencyMs: number };
  auth: AuthRole[];
  testData: Record<string, string>;
  llm?: LlmConfig;
  oracles: Record<OracleName, boolean>;
  /** `baseline`: absolute path, present only when configured. */
  findings: { lastActions: number; ignoreStatus: number[]; ignore: IgnoreRule[]; baseline?: string };
  report: { dir: string; keepDownloads: boolean };
  monkey: { actionTimeoutMs: number; maxTabs: number; weights: Record<ActionType, number> };
}

export type AuthRole = FieldsLoginRole | StorageStateRole;

export interface FieldsLoginRole {
  kind: "fields";
  name: string;
  loginUrl: string;
  fields: Record<string, string>;
  submit: string;
}

export interface StorageStateRole {
  kind: "storageState";
  name: string;
  /** Absolute path. */
  storageState: string;
}

/** At least one of `url` and `message` is set; both are valid regular expressions. */
export interface IgnoreRule {
  oracle?: OracleName;
  url?: string;
  message?: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  deployment: string;
  apiKey: string;
  required: boolean;
  timeoutMs: number;
  maxRetries: number;
  /** Absent: unlimited. */
  maxCalls?: number;
  /** Absent: unlimited. */
  maxTokens?: number;
  debugLog: boolean;
  historyActions: number;
  snapshotChars: number;
  handoff: RawHandoff;
  breaker: { failures: number; pauseSteps: number };
  pricing?: LlmPricing;
  options: { maxOutputTokens: number; thinking?: ThinkingType; effort?: EffortLevel; api?: OpenAiApi };
}

export interface LlmPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface LoadedConfig {
  config: Config;
  /**
   * Values that came from `${VAR}` placeholders in credential positions (`isCredential`); mask everything derived from
   * the config with them.
   */
  secrets: Secrets;
  /**
   * The secrets and the values of `${VAR}` in `baseUrl`: the action log stores them as placeholders, so a replay fills
   * in its own environment's values and runs on another host or port too.
   */
  variables: Secrets;
  /** True when no seed was configured and a random one was generated. */
  seedGenerated: boolean;
}

export interface ConfigIssue {
  /** Location in the config, e.g. `auth[0].fields.password`. */
  path: string;
  message: string;
}

/** A config that cannot be used. `issues` lists every problem found; none of them contains a secret value. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(source: string, issues: ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    super(`invalid config ${source}:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
}

/** Reads, resolves and validates a config file. Throws `ConfigError` on any problem. */
export async function loadConfig(file: string, options: LoadOptions = {}): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new ConfigError(file, [{ path: "(file)", message: `cannot read file (${code})` }]);
  }
  return parseConfig(text, { ...options, source: file, baseDir: dirname(resolve(file)) });
}

export interface ParseOptions extends LoadOptions {
  /** Name used in error messages. */
  source?: string;
  /** Directory that relative paths are resolved against. */
  baseDir?: string;
}

/** Parses, resolves and validates config JSON text. Throws `ConfigError` on any problem. */
export function parseConfig(text: string, options: ParseOptions = {}): LoadedConfig {
  const { env = process.env, source = "<config>", baseDir = process.cwd() } = options;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(source, [{ path: "(file)", message: `invalid JSON: ${(error as Error).message}` }]);
  }

  const { value: raw, secrets: substituted, missing } = resolvePlaceholders(json, env);
  const secrets = new Secrets(substituted.filter(({ path }) => isCredential(path)));
  const variables = new Secrets(substituted.filter(({ path }) => isCredential(path) || path[0] === "baseUrl"));
  const issues = findIssues(raw, missing);
  if (issues.length > 0) {
    throw new ConfigError(source, dedupe(issues, secrets));
  }

  const config = raw as RawConfig;
  const seedGenerated = config.seed === undefined && config.seeds === undefined;
  const seed = config.seeds?.[0] ?? config.seed ?? randomInt(0, MAX_SEED + 1);
  return {
    config: normalize(config, seed, baseDir),
    secrets,
    variables,
    seedGenerated,
  };
}

/**
 * Positions whose `${VAR}` values are secrets: login fields, test data (the monkey types both) and the LLM's API key.
 * Values elsewhere, such as a host in `baseUrl` or a role name, are configuration; masking them would garble findings.
 */
function isCredential(path: PathSegment[]): boolean {
  const [first, second, third] = path;
  if (first === "auth") return third === "fields";
  if (first === "llm") return second === "apiKey";
  return first === "testData";
}

function normalize(raw: RawConfig, seed: number, baseDir: string): Config {
  const config: Config = {
    baseUrl: raw.baseUrl,
    seed,
    parallel: raw.parallel ?? DEFAULTS.parallel,
    limits: {
      maxSteps: raw.limits?.maxSteps ?? DEFAULTS.limits.maxSteps,
      maxMinutes: raw.limits?.maxMinutes ?? DEFAULTS.limits.maxMinutes,
    },
    browser: normalizeBrowser(raw.browser),
    stayOnDomain: raw.stayOnDomain ?? DEFAULTS.stayOnDomain,
    scope: {
      allow: [...(raw.scope?.allow ?? DEFAULTS.scope.allow)],
      deny: [...(raw.scope?.deny ?? DEFAULTS.scope.deny)],
    },
    network: { latencyMs: raw.network?.latencyMs ?? DEFAULTS.network.latencyMs },
    auth: (raw.auth ?? []).map((role) => normalizeRole(role, baseDir)),
    testData: { ...raw.testData },
    oracles: Object.fromEntries(ORACLES.map((name) => [name, raw.oracles?.[name] ?? DEFAULTS.oracles[name]])) as Record<
      OracleName,
      boolean
    >,
    findings: normalizeFindings(raw.findings, baseDir),
    report: {
      dir: resolve(baseDir, raw.report?.dir ?? DEFAULTS.report.dir),
      keepDownloads: raw.report?.keepDownloads ?? DEFAULTS.report.keepDownloads,
    },
    monkey: normalizeMonkey(raw.monkey),
  };
  if (raw.seeds !== undefined) config.seeds = [...raw.seeds];
  if (raw.llm !== undefined) config.llm = normalizeLlm(raw.llm);
  return config;
}

function normalizeBrowser(raw: RawConfig["browser"]): Config["browser"] {
  return {
    engine: raw?.engine ?? DEFAULTS.browser.engine,
    viewport: [...(raw?.viewport ?? DEFAULTS.browser.viewport)],
    headless: raw?.headless ?? DEFAULTS.browser.headless,
  };
}

function normalizeFindings(raw: RawConfig["findings"], baseDir: string): Config["findings"] {
  return {
    lastActions: raw?.lastActions ?? DEFAULTS.findings.lastActions,
    ignoreStatus: [...(raw?.ignoreStatus ?? DEFAULTS.findings.ignoreStatus)],
    ignore: (raw?.ignore ?? []).map((rule) => ({ ...rule })),
    ...(raw?.baseline === undefined ? {} : { baseline: resolve(baseDir, raw.baseline) }),
  };
}

function normalizeMonkey(raw: RawConfig["monkey"]): Config["monkey"] {
  return {
    actionTimeoutMs: raw?.actionTimeoutMs ?? DEFAULTS.monkey.actionTimeoutMs,
    maxTabs: raw?.maxTabs ?? DEFAULTS.monkey.maxTabs,
    weights: Object.fromEntries(
      ACTION_TYPES.map((type) => [type, raw?.weights?.[type] ?? DEFAULTS.monkey.weights[type]]),
    ) as Record<ActionType, number>,
  };
}

function normalizeLlm(raw: RawLlm): LlmConfig {
  const defaults = DEFAULTS.llm;
  const handoff = Object.fromEntries(
    Object.entries(defaults.handoff).map(([key, value]) => [key, raw.handoff?.[key as keyof RawHandoff] ?? value]),
  ) as unknown as RawHandoff;
  const llm: LlmConfig = {
    provider: raw.provider,
    baseUrl: raw.baseUrl,
    deployment: raw.deployment,
    apiKey: raw.apiKey,
    required: raw.required ?? defaults.required,
    timeoutMs: raw.timeoutMs ?? defaults.timeoutMs,
    maxRetries: raw.maxRetries ?? defaults.maxRetries,
    debugLog: raw.debugLog ?? defaults.debugLog,
    historyActions: raw.historyActions ?? defaults.historyActions,
    snapshotChars: raw.snapshotChars ?? defaults.snapshotChars,
    handoff,
    breaker: {
      failures: raw.breaker?.failures ?? defaults.breaker.failures,
      pauseSteps: raw.breaker?.pauseSteps ?? defaults.breaker.pauseSteps,
    },
    options: { maxOutputTokens: raw.options?.maxOutputTokens ?? defaults.options.maxOutputTokens },
  };
  if (raw.maxCalls !== undefined) llm.maxCalls = raw.maxCalls;
  if (raw.maxTokens !== undefined) llm.maxTokens = raw.maxTokens;
  if (raw.pricing !== undefined) llm.pricing = { ...raw.pricing };
  if (raw.options?.thinking !== undefined) llm.options.thinking = raw.options.thinking;
  if (raw.options?.effort !== undefined) llm.options.effort = raw.options.effort;
  if (raw.options?.api !== undefined) llm.options.api = raw.options.api;
  return llm;
}

function normalizeRole(role: RawAuth, baseDir: string): AuthRole {
  // semanticIssues guarantees exactly one complete form.
  if (role.storageState !== undefined) {
    return { kind: "storageState", name: role.name, storageState: resolve(baseDir, role.storageState) };
  }
  return {
    kind: "fields",
    name: role.name,
    loginUrl: role.loginUrl as string,
    fields: { ...role.fields },
    submit: role.submit as string,
  };
}

function dedupe(issues: Issue[], secrets: Secrets): ConfigIssue[] {
  const seen = new Set<string>();
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    // Messages never include config values, but mask anyway as a last line of defence.
    const formatted = { path: secrets.mask(formatPath(issue.path)), message: secrets.mask(issue.message) };
    const key = `${formatted.path}\0${formatted.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(formatted);
    }
  }
  return out;
}
