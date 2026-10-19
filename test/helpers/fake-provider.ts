import {
  type DecideInput,
  type DecideOptions,
  type DecideResult,
  type InspectInput,
  type InspectResult,
  LlmError,
  type LlmProvider,
  type LlmUsage,
  type PreflightResult,
  type VisualBug,
} from "../../src/llm/provider.ts";
import { parseToolCall } from "../../src/llm/tools.ts";

/** One scripted answer: a tool call, a text-only reply, a failure, or none at all (`hang`, ignoring the signal). */
export type FakeResponse =
  | { tool: string; input?: unknown; usage?: LlmUsage }
  | { text: string; usage?: LlmUsage }
  | { error: LlmError }
  | { hang: true };

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
  /** The signal of every request, in order. */
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly inspections: InspectInput[] = [];
  visual: (input: InspectInput) => VisualBug[] | LlmError = () => [];
  readonly #script: FakeScript[];
  readonly #fallback: FakeScript;
  preflightResult: PreflightResult = { ok: true, latencyMs: 1 };

  constructor(script: FakeScript[] = [], fallback: FakeScript = { tool: "done", input: {} }) {
    this.#script = [...script];
    this.#fallback = fallback;
  }

  preflight(): Promise<PreflightResult> {
    return Promise.resolve(this.preflightResult);
  }

  /** Answers visual checks from `visual` (default: no bugs); every request is captured in `inspections`. */
  inspect(input: InspectInput): Promise<InspectResult> {
    this.inspections.push(input);
    return new Promise((resolve) => {
      const answer = this.visual(input);
      if (answer instanceof LlmError) throw answer;
      resolve({ bugs: answer, usage: FAKE_USAGE, retries: 0 });
    });
  }

  decide(input: DecideInput, options: DecideOptions = {}): Promise<DecideResult> {
    this.signals.push(options.signal);
    // A throw inside the executor rejects the promise, as a real backend's failure does.
    return new Promise((resolve) => {
      const answer = this.#answer(input);
      if (answer !== undefined) resolve(answer);
    });
  }

  /** The scripted answer, or undefined for one that never comes. */
  #answer(input: DecideInput): DecideResult | undefined {
    this.inputs.push(input);
    const next = this.#script.shift() ?? this.#fallback;
    const response = typeof next === "function" ? next(input) : next;
    if ("hang" in response) return undefined;
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
