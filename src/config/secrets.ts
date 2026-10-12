export const MASK = "***";

/** The values substituted from `${VAR}` placeholders. Anything derived from them must go through `mask`. */
export class Secrets {
  readonly #values: string[];

  constructor(values: Iterable<string>) {
    // Longest first, so a secret that contains another one is masked as a whole. Empty strings cannot be masked.
    this.#values = [...new Set(values)].filter((value) => value !== "").sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.#values.length;
  }

  /** Replaces every occurrence of every secret value in `text` with `***`. */
  mask(text: string): string {
    let out = text;
    for (const value of this.#values) out = out.replaceAll(value, MASK);
    return out;
  }
}

/** Returns a deep copy of `value` in which every string has its secret parts replaced by `***`. */
export function maskSecrets<T>(value: T, secrets: Secrets): T {
  return maskValue(value, secrets) as T;
}

function maskValue(value: unknown, secrets: Secrets): unknown {
  if (typeof value === "string") return secrets.mask(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item, secrets)]));
  }
  return value;
}
