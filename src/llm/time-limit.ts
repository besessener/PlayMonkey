import { type DecideInput, type DecideResult, LlmError, type LlmProvider } from "./provider.ts";

/** A call was cancelled because its run stops (its signal, or its deadline); this is no LLM failure. */
export class RunStopping extends Error {
  constructor() {
    super("the run is stopping");
    this.name = "RunStopping";
  }
}

export interface TimeLimit {
  /** `llm.timeoutMs`: one call, including the SDK's retries and reading the response. */
  timeoutMs: number;
  /** The run's stop signal, e.g. Ctrl+C. */
  signal?: AbortSignal | undefined;
  /** When the run must end, in epoch ms. */
  deadline?: number | undefined;
  now: () => number;
}

/**
 * The provider's decision within `timeoutMs`, cut to the run's deadline. A call still running then is cut off,
 * even when the provider ignores the signal: it fails as `timeout`, or with `RunStopping` when the run stops.
 */
export async function decideInTime(provider: LlmProvider, input: DecideInput, limit: TimeLimit): Promise<DecideResult> {
  const left = limit.deadline === undefined ? Number.POSITIVE_INFINITY : limit.deadline - limit.now();
  const clamped = left < limit.timeoutMs;
  const ms = clamped ? left : limit.timeoutMs;
  const run = limit.signal;
  if (run?.aborted === true || ms <= 0) throw new RunStopping();
  const timeout = AbortSignal.timeout(ms);
  const signal = run === undefined ? timeout : AbortSignal.any([run, timeout]);
  try {
    return await untilAborted(provider.decide(input, { signal }), signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    // `AbortSignal.any` takes the reason of whichever signal aborted first.
    if (clamped || signal.reason !== timeout.reason) throw new RunStopping();
    const retries = error instanceof LlmError ? error.retries : 0;
    throw new LlmError("timeout", `no decision within ${ms} ms (llm.timeoutMs)`, { retries });
  }
}

/** `promise`, or a rejection with the abort reason as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
