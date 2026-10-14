import { errors } from "playwright";

export const TIMEOUT = Symbol("timeout");
export const STOPPED = Symbol("stopped");

/** A page call did not settle in time: the page's main thread is blocked, so the page is closed and replaced. */
export class UnresponsivePageError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not respond within ${ms}ms`);
    this.name = "UnresponsivePageError";
  }
}

/** The promise's value, or `TIMEOUT` after `ms`. Page calls without a timeout of their own never settle on a frozen page. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // A hung call settles when the page is closed; nobody waits for it any more.
    promise.catch(() => undefined);
  }
}

/** The promise's value; throws `UnresponsivePageError` naming `what` when it does not settle within `ms`. */
export async function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const value = await withTimeout(promise, ms);
  if (value === TIMEOUT) throw new UnresponsivePageError(what, ms);
  return value;
}

/** True for an error that means the page stopped responding, not that an element was missing. */
export function isUnresponsive(error: unknown): boolean {
  return error instanceof UnresponsivePageError || error instanceof errors.TimeoutError;
}

/** The work's result, or `STOPPED` after `ms` or when the signal aborts, whichever comes first. */
export async function untilDeadline<T>(
  work: Promise<T>,
  { ms, signal }: { ms: number; signal?: AbortSignal },
): Promise<T | typeof STOPPED> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    onAbort = () => resolve(STOPPED);
    timer = setTimeout(onAbort, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    // Abandoned work fails once the session closes; its error is of no interest any more.
    work.catch(() => undefined);
  }
}
