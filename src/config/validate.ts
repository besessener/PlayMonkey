import { Ajv, type ErrorObject } from "ajv";
import { formatPath, type PathSegment, pointerToSegments } from "./path.ts";
import type { MissingVariable } from "./placeholders.ts";
import { configSchema } from "./schema.ts";

/** A problem found in the config, before its path is formatted and secrets are masked. */
export interface Issue {
  path: PathSegment[];
  message: string;
}

const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(configSchema);

/** Every problem of a config with resolved placeholders; `missing` are the placeholders that could not be resolved. */
export function findIssues(raw: unknown, missing: MissingVariable[]): Issue[] {
  const issues: Issue[] = [];
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
  return issues;
}

/** Rules JSON Schema cannot express clearly. Written defensively: runs even when the schema check failed. */
function semanticIssues(raw: unknown): Issue[] {
  if (!isObject(raw)) return [];
  const issues: Issue[] = [];
  if (raw.seed !== undefined && raw.seeds !== undefined) {
    issues.push({ path: ["seeds"], message: "use either seed or seeds, not both" });
  }
  if (typeof raw.baseUrl === "string" && !isHttpUrl(raw.baseUrl)) {
    issues.push({ path: ["baseUrl"], message: "must be an absolute http(s) URL" });
  }
  return [
    ...issues,
    ...scopeIssues(raw.scope, raw.baseUrl),
    ...llmIssues(raw.llm),
    ...ignoreRulesIssues(raw.findings),
    ...authIssues(raw.auth),
  ];
}

/** Every pattern is a valid regular expression, and `baseUrl` itself is in scope. */
function scopeIssues(scope: unknown, baseUrl: unknown): Issue[] {
  if (!isObject(scope)) return [];
  const allow = patternList(scope.allow);
  const deny = patternList(scope.deny);
  const invalid = [
    ...allow.invalid.map((index) => ["allow", index]),
    ...deny.invalid.map((index) => ["deny", index]),
  ].map(([key, index]) => ({
    path: ["scope", key as string, index as number],
    message: "is not a valid regular expression",
  }));
  if (invalid.length > 0 || typeof baseUrl !== "string") return invalid;
  const issues: Issue[] = [];
  if (allow.valid.length > 0 && !allow.valid.some((pattern) => pattern.test(baseUrl))) {
    issues.push({ path: ["scope", "allow"], message: "does not allow baseUrl, where every run starts" });
  }
  if (deny.valid.some((pattern) => pattern.test(baseUrl))) {
    issues.push({ path: ["scope", "deny"], message: "denies baseUrl, where every run starts" });
  }
  return issues;
}

/** The valid patterns of a list, and the indexes of the invalid ones. Non-strings are the schema's business. */
function patternList(list: unknown): { valid: RegExp[]; invalid: number[] } {
  const result: { valid: RegExp[]; invalid: number[] } = { valid: [], invalid: [] };
  if (!Array.isArray(list)) return result;
  for (const [index, pattern] of list.entries()) {
    if (typeof pattern !== "string") continue;
    if (isRegExp(pattern)) result.valid.push(new RegExp(pattern));
    else result.invalid.push(index);
  }
  return result;
}

function llmIssues(llm: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(llm)) return issues;
  if (typeof llm.baseUrl === "string" && !isHttpUrl(llm.baseUrl)) {
    issues.push({ path: ["llm", "baseUrl"], message: "must be an absolute http(s) URL" });
  }
  if (isObject(llm.options)) {
    const { provider, options } = llm;
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
  return issues;
}

function ignoreRulesIssues(findings: unknown): Issue[] {
  if (!(isObject(findings) && Array.isArray(findings.ignore))) return [];
  return findings.ignore.flatMap((rule: unknown, index) =>
    isObject(rule) ? ignoreRuleIssues(rule, ["findings", "ignore", index]) : [],
  );
}

function ignoreRuleIssues(rule: Record<string, unknown>, path: PathSegment[]): Issue[] {
  const issues: Issue[] = [];
  if (rule.url === undefined && rule.message === undefined) {
    issues.push({ path, message: "needs url or message; use oracles.<name>: false to switch an oracle off" });
  }
  for (const key of ["url", "message"]) {
    const pattern = rule[key];
    if (typeof pattern === "string" && !isRegExp(pattern)) {
      issues.push({ path: [...path, key], message: "is not a valid regular expression" });
    }
  }
  return issues;
}

function authIssues(auth: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!Array.isArray(auth)) return issues;
  const seen = new Map<string, number>();
  for (const [index, role] of (auth as unknown[]).entries()) {
    if (!isObject(role)) continue;
    const path = ["auth", index];
    issues.push(...roleFormIssues(role, path));
    if (typeof role.name === "string") {
      const first = seen.get(role.name);
      if (first === undefined) seen.set(role.name, index);
      else issues.push({ path: [...path, "name"], message: `duplicate role name, already used by auth[${first}]` });
    }
  }
  return issues;
}

/** A role uses either fields (with loginUrl and submit) or storageState. */
function roleFormIssues(role: Record<string, unknown>, path: PathSegment[]): Issue[] {
  const hasFields = role.fields !== undefined;
  const hasState = role.storageState !== undefined;
  if (hasFields && hasState) {
    return [{ path, message: "use either fields (with loginUrl and submit) or storageState, not both" }];
  }
  if (!(hasFields || hasState)) {
    return [{ path, message: "needs either fields (with loginUrl and submit) or storageState" }];
  }
  const keys = ["loginUrl", "submit"];
  if (hasFields) {
    return keys
      .filter((key) => role[key] === undefined)
      .map((key) => ({ path: [...path, key], message: "is required with fields" }));
  }
  return keys
    .filter((key) => role[key] !== undefined)
    .map((key) => ({ path: [...path, key], message: "is only allowed with fields, not with storageState" }));
}

function schemaIssue(error: ErrorObject): Issue {
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

function isRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
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
