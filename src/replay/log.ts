import { readFile, rename, writeFile } from "node:fs/promises";
import { resolvePlaceholders } from "../config/placeholders.ts";
import type { Secrets } from "../config/secrets.ts";
import type { Action } from "../monkey/actions.ts";
import type { StepEvent } from "../monkey/events.ts";
import type { StepRecord } from "../monkey/loop.ts";
import type { Finding } from "../oracles/finding.ts";

/**
 * Version 2 added the actions `dblclick`, `rightclick`, `hover`, `longPress` and `drag` (with `toRef` and
 * `toLocator`) and the `events` of a step. Version 1 logs are a subset and still read.
 */
export const ACTION_LOG_VERSION = 2;
const READABLE_VERSIONS: readonly number[] = [1, 2];

/** Fields of a logged action that hold free text, where secret values are replaced by their placeholders. */
const TEXT_FIELDS = ["value", "url", "key", "locator", "toLocator", "pageUrl", "error"] as const;

/** One executed action: the action's own fields (`type`, `ref`, `value`, …) plus where and how it ran. */
export type LoggedAction = Action & {
  step: number;
  source: StepRecord["source"];
  /** Durable locator of the element; replay resolves element actions by it, since refs do not survive page loads. */
  locator?: string;
  /** Durable locator of the drop target of a `drag`. */
  toLocator?: string;
  /** URL and snapshot hash of the state the action was chosen in (`url` is the target of `navigate`). */
  pageUrl: string;
  snapshotHash: string;
  ok: boolean;
  error?: string;
  /** Dialogs answered, files uploaded and downloads during the step; replay gives the same answers. */
  events?: StepEvent[];
};

/** What replay compares against. */
export type LoggedFinding = Pick<Finding, "id" | "oracle" | "severity" | "key" | "message" | "step">;

/**
 * `actions.json`: every action of one role's run, in order. Values that came from `${VAR}` placeholders are stored
 * as the placeholder (listed in `placeholders`) and resolved from the environment again on replay.
 */
export interface ActionLog {
  version: number;
  seed: number;
  baseUrl: string;
  role: string;
  viewport: [number, number];
  placeholders: string[];
  actions: LoggedAction[];
  findings: LoggedFinding[];
}

/** The action log cannot be read or used. Maps to exit code 2. */
export class ActionLogError extends Error {
  constructor(file: string, reason: string) {
    super(`action log ${file}: ${reason}`);
    this.name = "ActionLogError";
  }
}

/**
 * Writes `actions.json` for one role. Every `append` rewrites the file atomically (temporary file, then rename),
 * so the log on disk is always complete and valid JSON, also when the run crashes.
 */
export class ActionLogWriter {
  readonly file: string;
  readonly #log: ActionLog;
  readonly #secrets: Secrets;

  constructor(file: string, header: Pick<ActionLog, "seed" | "baseUrl" | "role" | "viewport">, secrets: Secrets) {
    this.file = file;
    this.#secrets = secrets;
    this.#log = {
      version: ACTION_LOG_VERSION,
      ...header,
      baseUrl: secrets.toPlaceholders(header.baseUrl),
      role: secrets.toPlaceholders(header.role),
      placeholders: secrets.names,
      actions: [],
      findings: [],
    };
  }

  async append(record: StepRecord): Promise<void> {
    const entry = {
      step: record.step,
      source: record.source,
      ...record.action,
      ...(record.locator === undefined ? {} : { locator: record.locator }),
      ...(record.toLocator === undefined ? {} : { toLocator: record.toLocator }),
      pageUrl: record.url,
      snapshotHash: record.snapshotHash,
      ok: record.result.ok,
      ...(record.result.error === undefined ? {} : { error: record.result.error }),
      ...(record.events === undefined || record.events.length === 0
        ? {}
        : { events: record.events.map((event) => this.#maskEvent(event)) }),
    } as LoggedAction;
    // Only free text can carry a secret; structural fields (type, source, ref, hash) stay as they are.
    for (const key of TEXT_FIELDS) {
      const value = (entry as Record<string, unknown>)[key];
      if (typeof value === "string") (entry as Record<string, unknown>)[key] = this.#secrets.toPlaceholders(value);
    }
    this.#log.actions.push(entry);
    await this.#write();
  }

  /** Pages may echo secrets in dialog messages, and URLs may contain them. */
  #maskEvent(event: StepEvent): StepEvent {
    const hide = (text: string) => this.#secrets.toPlaceholders(text);
    switch (event.kind) {
      case "dialog":
        return {
          ...event,
          message: hide(event.message),
          ...(event.text === undefined ? {} : { text: hide(event.text) }),
        };
      case "download":
        return { ...event, name: hide(event.name), url: hide(event.url) };
      case "upload":
        return event;
    }
  }

  async setFindings(findings: Finding[]): Promise<void> {
    this.#log.findings = findings.map(({ id, oracle, severity, key, message, step }) => ({
      id,
      oracle,
      severity,
      key: this.#secrets.toPlaceholders(key),
      message: this.#secrets.toPlaceholders(message),
      step,
    }));
    await this.#write();
  }

  async #write(): Promise<void> {
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#log, null, 2)}\n`);
    await rename(temporary, this.file);
  }
}

/**
 * Reads and checks an action log and resolves its placeholders from `env`. Returns the log with real values and
 * the resolved values, which must be masked in all output.
 */
export async function readActionLog(
  file: string,
  env: NodeJS.ProcessEnv,
): Promise<{ log: ActionLog; secrets: { name: string; value: string }[] }> {
  const json = await readJson(file);
  const fail = (reason: string): never => {
    throw new ActionLogError(file, reason);
  };
  if (!isObject(json)) return fail("not a PlayMonkey action log");
  if (typeof json.version !== "number" || !READABLE_VERSIONS.includes(json.version)) {
    return fail(
      `unsupported version ${JSON.stringify(json.version)}; this monkey reads versions ${READABLE_VERSIONS.join(" and ")}`,
    );
  }
  if (!(Array.isArray(json.placeholders) && json.placeholders.every((name) => typeof name === "string"))) {
    fail("placeholders must be a list of variable names");
  }

  const names = new Set(json.placeholders as string[]);
  const { value, secrets, missing } = resolvePlaceholders(json, env, names);
  if (missing.length > 0) {
    const variables = [...new Set(missing.map(({ name }) => name))].join(", ");
    fail(`environment variable${missing.length > 1 ? "s" : ""} ${variables} not set; the log needs them for replay`);
  }
  const problem = checkLog(value as Record<string, unknown>);
  if (problem !== undefined) fail(problem);
  return { log: value as ActionLog, secrets };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const reason =
      error instanceof SyntaxError
        ? `invalid JSON: ${error.message}`
        : `cannot read file (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
    throw new ActionLogError(file, reason);
  }
}

/** Returns why a log with resolved placeholders is not usable, or undefined. */
function checkLog(log: Record<string, unknown>): string | undefined {
  if (typeof log.baseUrl !== "string") return "baseUrl must be a string";
  if (typeof log.role !== "string") return "role must be a string";
  if (!Number.isInteger(log.seed)) return "seed must be an integer";
  if (!Array.isArray(log.viewport) || log.viewport.length !== 2 || !log.viewport.every(isPositiveInteger)) {
    return "viewport must be [width, height]";
  }
  if (!Array.isArray(log.actions)) return "actions must be a list";
  if (!Array.isArray(log.findings)) return "findings must be a list";
  for (const [index, entry] of (log.actions as unknown[]).entries()) {
    const problem = checkAction(entry);
    if (problem !== undefined) return `actions[${index}]: ${problem}`;
  }
  for (const [index, entry] of (log.findings as unknown[]).entries()) {
    if (!isObject(entry) || typeof entry.key !== "string" || typeof entry.id !== "string") {
      return `findings[${index}]: needs id and key`;
    }
  }
  return undefined;
}

/** Returns why `entry` is not a loggable action, or undefined. */
function checkAction(entry: unknown): string | undefined {
  if (!isObject(entry)) return "must be an object";
  if (!isPositiveInteger(entry.step)) return "step must be a positive integer";
  if (entry.source !== "monkey" && entry.source !== "llm") return 'source must be "monkey" or "llm"';
  const problem = checkActionFields(entry);
  if (problem !== undefined) return problem;
  if (entry.locator !== undefined && typeof entry.locator !== "string") return "locator must be a string";
  if (entry.toLocator !== undefined && typeof entry.toLocator !== "string") return "toLocator must be a string";
  if (entry.events !== undefined && !(Array.isArray(entry.events) && entry.events.every(isEvent))) {
    return "events must be a list of dialog, upload and download events";
  }
  if (typeof entry.pageUrl !== "string") return "pageUrl must be a string";
  return undefined;
}

/** Returns why `entry` is not a known action type with the fields that type needs, or undefined. */
function checkActionFields(entry: Record<string, unknown>): string | undefined {
  const fields: Record<string, Record<string, "string" | "number">> = {
    click: { ref: "string" },
    dblclick: { ref: "string" },
    rightclick: { ref: "string" },
    hover: { ref: "string" },
    longPress: { ref: "string" },
    drag: { ref: "string", toRef: "string" },
    check: { ref: "string" },
    uncheck: { ref: "string" },
    fill: { ref: "string", value: "string" },
    select: { ref: "string", value: "string" },
    press: { key: "string" },
    scroll: { deltaY: "number" },
    back: {},
    navigate: { url: "string" },
    setViewport: { width: "number", height: "number" },
    switchTab: { index: "number" },
  };
  const expected = typeof entry.type === "string" ? fields[entry.type] : undefined;
  if (expected === undefined) return `unknown action type ${JSON.stringify(entry.type)}`;
  for (const [key, type] of Object.entries(expected)) {
    if (typeof entry[key] !== type) return `${entry.type} needs ${key} (${type})`;
  }
  return undefined;
}

function isEvent(event: unknown): boolean {
  if (!isObject(event)) return false;
  switch (event.kind) {
    case "dialog":
      return typeof event.dialog === "string" && typeof event.accepted === "boolean";
    case "upload":
      return Array.isArray(event.files) && event.files.every((name) => typeof name === "string");
    case "download":
      return typeof event.name === "string" && typeof event.url === "string";
    default:
      return false;
  }
}

/** The action part of a logged entry. */
export function toAction(entry: LoggedAction): Action {
  switch (entry.type) {
    case "click":
    case "dblclick":
    case "rightclick":
    case "hover":
    case "longPress":
    case "check":
    case "uncheck":
      return { type: entry.type, ref: entry.ref };
    case "drag":
      return { type: "drag", ref: entry.ref, toRef: entry.toRef };
    case "fill":
    case "select":
      return { type: entry.type, ref: entry.ref, value: entry.value };
    case "press":
      return { type: "press", key: entry.key };
    case "scroll":
      return { type: "scroll", deltaY: entry.deltaY };
    case "back":
      return { type: "back" };
    case "navigate":
      return { type: "navigate", url: entry.url };
    case "setViewport":
      return { type: "setViewport", width: entry.width, height: entry.height };
    case "switchTab":
      return { type: "switchTab", index: entry.index };
  }
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
