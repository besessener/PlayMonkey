import type { SecretValue } from "./placeholders.ts";

export const MASK = "***";

/** The values substituted from `${VAR}` placeholders. Anything derived from them must go through `mask`. */
export class Secrets {
  /** Value → name of the first variable that produced it. */
  readonly #names = new Map<string, string>();
  readonly #values: string[];
  readonly #pattern: RegExp | undefined;

  /** Every form of every value (`secretForms`) → name of the first variable that produced it. */
  readonly #forms = new Map<string, string>();

  constructor(secrets: Iterable<SecretValue>) {
    for (const { name, value } of secrets) if (value !== "" && !this.#names.has(value)) this.#names.set(value, name);
    for (const [value, name] of this.#names) {
      for (const form of secretForms(value)) if (!this.#forms.has(form)) this.#forms.set(form, name);
    }
    // Longest first, so a secret that contains another one is masked as a whole. Empty strings cannot be masked.
    this.#values = [...this.#forms.keys()].sort((a, b) => b.length - a.length);
    if (this.#values.length > 0) {
      this.#pattern = new RegExp(
        this.#values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "g",
      );
    }
  }

  get size(): number {
    return this.#names.size;
  }

  /** Every value with the variable it came from, e.g. to combine two sets of secrets. */
  get entries(): SecretValue[] {
    return [...this.#names].map(([value, name]) => ({ name, value }));
  }

  /** Names of the variables behind the secret values. */
  get names(): string[] {
    return [...new Set(this.#names.values())].sort();
  }

  /** Replaces every occurrence of every secret value in `text`, also URL-encoded or JSON-escaped, with `***`. */
  mask(text: string): string {
    let out = text;
    for (const value of this.#values) out = out.replaceAll(value, MASK);
    return out;
  }

  /** Replaces every occurrence of every secret value in `text` with its placeholder, e.g. `${ADMIN_PASS}`. */
  toPlaceholders(text: string): string {
    if (this.#pattern === undefined) return text;
    // One pass, so a shorter secret never matches inside a placeholder that was just inserted.
    return text.replace(this.#pattern, (value) => `\${${this.#forms.get(value)}}`);
  }
}

/**
 * The forms a value takes in output: as is, URL-encoded (a path or a query, also form-encoded with `+`) and escaped
 * in a JSON string. Masking only the raw value would miss it in a page URL or a JSON log.
 */
export function secretForms(value: string): string[] {
  const forms = [
    value,
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
    JSON.stringify(value).slice(1, -1),
  ];
  return [...new Set(forms)];
}

/** Returns a deep copy of `value` in which every string has its secret parts replaced by `***`. */
export function maskSecrets<T>(value: T, secrets: Secrets): T {
  return mapStrings(value, (text) => secrets.mask(text)) as T;
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]));
  }
  return value;
}
