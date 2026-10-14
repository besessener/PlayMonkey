import type { Action } from "../monkey/actions.ts";

/**
 * A backend that picks the next action. Backends are interchangeable: they share the tool definitions
 * (`ACTION_TOOLS`), the prompt (`buildPrompt`) and the validation of returned tool calls (`parseToolCall`).
 */
export interface LlmProvider {
  /** Provider name from the config, e.g. `anthropic-foundry`. */
  readonly name: string;
  /** Sends one small request that must come back as a tool call. Never throws. */
  preflight(): Promise<PreflightResult>;
  /**
   * Asks for the next action. Throws `LlmError` on every failure, including a response without a valid tool call;
   * the error carries the usage of the failed call when there was a response.
   */
  decide(input: DecideInput): Promise<DecideResult>;
}

/** Everything the model sees. Contains no secret values: they are replaced by `{{…}}` placeholders. */
export interface DecideInput {
  /** The page, serialized within a character budget (`serializeSnapshot`). */
  snapshot: string;
  /** Refs of the snapshot's elements; tool calls naming any other ref are rejected. */
  refs: ReadonlySet<string>;
  /** The last actions, oldest first. */
  history: HistoryEntry[];
  /** One line per finding so far, e.g. `high pageerror: Error: boom`. */
  findingsSoFar: string[];
  /** Why the monkey handed over, e.g. `a dialog is open: "Cookies"`. */
  goal: string;
  /** Keys of `testData`, usable as `{{testData.<key>}}`. */
  testDataKeys: string[];
  /** Every placeholder the model may use in values, e.g. `{{admin.password}}`. */
  placeholders: string[];
  /** Name of the role the browser is logged in as. */
  role: string;
}

export interface HistoryEntry {
  step: number;
  source: "monkey" | "llm";
  /** The action in words, e.g. `fill e8 "abc"`; secret values replaced by placeholders. */
  action: string;
  ok: boolean;
  error?: string;
  url: string;
}

/** What the model chose: an action, or `done` to give control back to the monkey. */
export type Decision = Action | { type: "done" };

export interface DecideResult {
  decision: Decision;
  usage: LlmUsage;
  /** Requests the SDK repeated after a retryable error. */
  retries: number;
  /** The provider's response for `llm.debugLog`; never logged otherwise. */
  raw?: unknown;
}

export interface LlmUsage {
  /** Input tokens neither read from nor written to the prompt cache; the four counts never overlap. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache, when the provider reports them. */
  cachedTokens?: number;
  /** Input tokens written to the prompt cache, when the provider reports them. */
  cacheWriteTokens?: number;
}

export type PreflightResult = { ok: true; latencyMs: number; usage?: LlmUsage } | { ok: false; error: LlmError };

/**
 * Why a call failed. `invalid` (no or a malformed tool call), `refusal` and `maxTokens` are bad responses; the
 * others are transport and HTTP problems.
 */
export type LlmErrorKind =
  | "unreachable"
  | "tls"
  | "timeout"
  | "auth"
  | "forbidden"
  | "notFound"
  | "rateLimited"
  | "badRequest"
  | "server"
  | "invalid"
  | "refusal"
  | "maxTokens"
  | "other";

/** Kinds that mean the response arrived but was unusable: retried once with the same input. */
export const RESPONSE_ERRORS: ReadonlySet<LlmErrorKind> = new Set(["invalid", "refusal", "maxTokens"]);

/** A failed LLM call. The message never contains the API key or a secret value. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly usage?: LlmUsage;
  readonly retries: number;
  readonly raw?: unknown;

  constructor(
    kind: LlmErrorKind,
    message: string,
    details: { status?: number; usage?: LlmUsage; retries?: number; raw?: unknown } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.usage !== undefined) this.usage = details.usage;
    this.retries = details.retries ?? 0;
    if (details.raw !== undefined) this.raw = details.raw;
  }
}
