import {
  type DecideInput,
  type DecideResult,
  LlmError,
  type LlmProvider,
  type LlmUsage,
  type PreflightResult,
} from "../../src/llm/provider.ts";
import { parseToolCall } from "../../src/llm/tools.ts";

/** One scripted answer: a tool call, a text-only reply, or a failure. */
export type FakeResponse =
  | { tool: string; input?: unknown; usage?: LlmUsage }
  | { text: string; usage?: LlmUsage }
  | { error: LlmError };

/** Answers in order; a function answers from the request, e.g. to click a ref of the current snapshot. */
export type FakeScript = FakeResponse | ((input: DecideInput) => FakeResponse);

export const FAKE_USAGE: LlmUsage = { inputTokens: 1000, outputTokens: 20, cachedTokens: 500 };

/**
 * `LlmProvider` with scripted responses. Tool calls go through the same `parseToolCall` as a real backend, and
 * every request is captured in `inputs`. When the script runs out, it repeats `fallback` (default: `done`).
 */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly inputs: DecideInput[] = [];
  readonly #script: FakeScript[];
  readonly #fallback: FakeScript;
  preflightResult: PreflightResult = { ok: true, latencyMs: 1 };

  constructor(script: FakeScript[] = [], fallback: FakeScript = { tool: "done", input: {} }) {
    this.#script = [...script];
    this.#fallback = fallback;
  }

  async preflight(): Promise<PreflightResult> {
    return this.preflightResult;
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    this.inputs.push(input);
    const next = this.#script.shift() ?? this.#fallback;
    const response = typeof next === "function" ? next(input) : next;
    if ("error" in response) throw response.error;
    const usage = response.usage ?? FAKE_USAGE;
    if ("text" in response) throw new LlmError("invalid", "the response contained text only, no tool call", { usage });
    try {
      return { decision: parseToolCall(response.tool, response.input ?? {}, input.refs), usage, retries: 0 };
    } catch (error) {
      if (error instanceof LlmError) throw new LlmError(error.kind, error.message, { usage });
      throw error;
    }
  }
}
