import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { formatPath, type PathSegment, pointerToSegments } from "./path.ts";
import { resolvePlaceholders } from "./placeholders.ts";
import {
  ACTION_TYPES,
  type ActionType,
  configSchema,
  DEFAULTS,
  type EffortLevel,
  type Engine,
  type LlmProvider,
  MAX_SEED,
  type OpenAiApi,
  ORACLES,
  type OracleName,
  type RawAuth,
  type RawConfig,
  type RawHandoff,
  type RawLlm,
  type ThinkingType,
} from "./schema.ts";
import { Secrets } from "./secrets.ts";

/** The validated config with all defaults applied and relative paths resolved against the config file. */
export interface Config {
  baseUrl: string;
  seed: number;
  limits: { maxSteps: number; maxMinutes: number };
  browser: { engine: Engine; viewport: [number, number]; headless: boolean };
  stayOnDomain: boolean;
  auth: AuthRole[];
  testData: Record<string, string>;
  llm?: LlmConfig;
  oracles: Record<OracleName, boolean>;
  findings: { lastActions: number; ignoreStatus: number[]; ignore: IgnoreRule[] };
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
  /** Values that came from `${VAR}` placeholders; mask everything derived from the config with them. */
  secrets: Secrets;
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

const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(configSchema);

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

  const { value: raw, secrets: secretValues, missing } = resolvePlaceholders(json, env);
  const secrets = new Secrets(secretValues);
  const issues: { path: PathSegment[]; message: string }[] = [];

  for (const { path, name } of missing) {
    issues.push({ path, message: `environment variable ${name} is not set` });
  }
  for (const path of findNulls(raw, [])) {
    issues.push({ path, message: "null is not allowed; omit the key to use the default" });
  }
  if (!validateSchema(raw)) {
    for (const error of validateSchema.errors ?? []) issues.push(schemaIssue(error));
  }
  const unresolved = new Set(missing.map(({ path }) => formatPath(path)));
  issues.push(...semanticIssues(raw).filter(({ path }) => !unresolved.has(formatPath(path))));

  if (issues.length > 0) {
    throw new ConfigError(source, dedupe(issues, secrets));
  }

  const config = raw as RawConfig;
  const seedGenerated = config.seed === undefined;
  return {
    config: normalize(config, seedGenerated ? randomInt(0, MAX_SEED + 1) : (config.seed as number), baseDir),
    secrets,
    seedGenerated,
  };
}

function normalize(raw: RawConfig, seed: number, baseDir: string): Config {
  const config: Config = {
    baseUrl: raw.baseUrl,
    seed,
    limits: {
      maxSteps: raw.limits?.maxSteps ?? DEFAULTS.limits.maxSteps,
      maxMinutes: raw.limits?.maxMinutes ?? DEFAULTS.limits.maxMinutes,
    },
    browser: {
      engine: raw.browser?.engine ?? DEFAULTS.browser.engine,
      viewport: [...(raw.browser?.viewport ?? DEFAULTS.browser.viewport)],
      headless: raw.browser?.headless ?? DEFAULTS.browser.headless,
    },
    stayOnDomain: raw.stayOnDomain ?? DEFAULTS.stayOnDomain,
    auth: (raw.auth ?? []).map((role) => normalizeRole(role, baseDir)),
    testData: { ...raw.testData },
    oracles: Object.fromEntries(ORACLES.map((name) => [name, raw.oracles?.[name] ?? DEFAULTS.oracle])) as Record<
      OracleName,
      boolean
    >,
    findings: {
      lastActions: raw.findings?.lastActions ?? DEFAULTS.findings.lastActions,
      ignoreStatus: [...(raw.findings?.ignoreStatus ?? DEFAULTS.findings.ignoreStatus)],
      ignore: (raw.findings?.ignore ?? []).map((rule) => ({ ...rule })),
    },
    report: {
      dir: resolve(baseDir, raw.report?.dir ?? DEFAULTS.report.dir),
      keepDownloads: raw.report?.keepDownloads ?? DEFAULTS.report.keepDownloads,
    },
    monkey: {
      actionTimeoutMs: raw.monkey?.actionTimeoutMs ?? DEFAULTS.monkey.actionTimeoutMs,
      maxTabs: raw.monkey?.maxTabs ?? DEFAULTS.monkey.maxTabs,
      weights: Object.fromEntries(
        ACTION_TYPES.map((type) => [type, raw.monkey?.weights?.[type] ?? DEFAULTS.monkey.weights[type]]),
      ) as Record<ActionType, number>,
    },
  };
  if (raw.llm !== undefined) config.llm = normalizeLlm(raw.llm);
  return config;
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

/** Rules JSON Schema cannot express clearly. Written defensively: runs even when the schema check failed. */
function semanticIssues(raw: unknown): { path: PathSegment[]; message: string }[] {
  const issues: { path: PathSegment[]; message: string }[] = [];
  if (!isObject(raw)) return issues;

  if (typeof raw.baseUrl === "string" && !isHttpUrl(raw.baseUrl)) {
    issues.push({ path: ["baseUrl"], message: "must be an absolute http(s) URL" });
  }
  if (isObject(raw.llm) && typeof raw.llm.baseUrl === "string" && !isHttpUrl(raw.llm.baseUrl)) {
    issues.push({ path: ["llm", "baseUrl"], message: "must be an absolute http(s) URL" });
  }
  if (isObject(raw.llm) && isObject(raw.llm.options)) {
    const { provider, options } = raw.llm;
    if (options.thinking !== undefined && provider === "openai") {
      issues.push({
        path: ["llm", "options", "thinking"],
        message: "is only for anthropic-foundry; use effort instead",
      });
    }
    if (options.api !== undefined && provider === "anthropic-foundry") {
      issues.push({ path: ["llm", "options", "api"], message: "is only for the openai provider" });
    }
  }

  if (isObject(raw.findings) && Array.isArray(raw.findings.ignore)) {
    raw.findings.ignore.forEach((rule: unknown, index) => {
      if (!isObject(rule)) return;
      const path = ["findings", "ignore", index];
      if (rule.url === undefined && rule.message === undefined) {
        issues.push({ path, message: "needs url or message; use oracles.<name>: false to switch an oracle off" });
      }
      for (const key of ["url", "message"]) {
        const pattern = rule[key];
        if (typeof pattern !== "string") continue;
        try {
          new RegExp(pattern);
        } catch {
          issues.push({ path: [...path, key], message: "is not a valid regular expression" });
        }
      }
    });
  }

  if (Array.isArray(raw.auth)) {
    const seen = new Map<string, number>();
    raw.auth.forEach((role: unknown, index) => {
      if (!isObject(role)) return;
      const path = ["auth", index];
      const hasFields = role.fields !== undefined;
      const hasState = role.storageState !== undefined;
      if (hasFields && hasState) {
        issues.push({ path, message: "use either fields (with loginUrl and submit) or storageState, not both" });
      } else if (!hasFields && !hasState) {
        issues.push({ path, message: "needs either fields (with loginUrl and submit) or storageState" });
      } else if (hasFields) {
        for (const key of ["loginUrl", "submit"]) {
          if (role[key] === undefined) issues.push({ path: [...path, key], message: "is required with fields" });
        }
      } else {
        for (const key of ["loginUrl", "submit"]) {
          if (role[key] !== undefined) {
            issues.push({ path: [...path, key], message: "is only allowed with fields, not with storageState" });
          }
        }
      }
      if (typeof role.name === "string") {
        const first = seen.get(role.name);
        if (first === undefined) seen.set(role.name, index);
        else issues.push({ path: [...path, "name"], message: `duplicate role name, already used by auth[${first}]` });
      }
    });
  }
  return issues;
}

function schemaIssue(error: ErrorObject): { path: PathSegment[]; message: string } {
  const path = pointerToSegments(error.instancePath);
  switch (error.keyword) {
    case "additionalProperties":
      return { path: [...path, error.params.additionalProperty as string], message: "unknown key" };
    case "required":
      return { path: [...path, error.params.missingProperty as string], message: "is required" };
    case "enum":
      return { path, message: `must be one of: ${(error.params.allowedValues as string[]).join(", ")}` };
    default:
      return { path, message: error.message ?? `failed ${error.keyword} check` };
  }
}

function findNulls(node: unknown, path: PathSegment[]): PathSegment[][] {
  if (node === null) return [path];
  if (Array.isArray(node)) return node.flatMap((item, index) => findNulls(item, [...path, index]));
  if (isObject(node)) return Object.entries(node).flatMap(([key, item]) => findNulls(item, [...path, key]));
  return [];
}

function dedupe(issues: { path: PathSegment[]; message: string }[], secrets: Secrets): ConfigIssue[] {
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
