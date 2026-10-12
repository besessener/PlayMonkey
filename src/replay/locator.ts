import type { FrameLocator, Locator, Page } from "playwright";

/** The durable locator text cannot be turned back into a locator. */
export class LocatorSyntaxError extends Error {
  constructor(text: string, reason: string) {
    super(`cannot read locator ${JSON.stringify(text)}: ${reason}`);
    this.name = "LocatorSyntaxError";
  }
}

type Value = string | number | boolean | RegExp | { [key: string]: Value };

/** Methods a durable locator may call, as `Locator.normalize().toString()` writes them. Nothing else is callable. */
const METHODS = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "contentFrame",
  "frameLocator",
  "first",
  "last",
  "nth",
  "filter",
]);

/**
 * Turns a durable locator from the action log, e.g. `getByRole('button', { name: 'Send' }).nth(1)` or
 * `locator('iframe').contentFrame().getByRole('link', { name: 'Home' })`, back into a Playwright locator. Only the
 * methods in `METHODS` with literal arguments are accepted; the text is parsed, never evaluated.
 */
export function parseLocator(page: Page, text: string): Locator {
  const calls = new Parser(text).calls();
  let target: Page | Locator | FrameLocator = page;
  for (const { method, args } of calls) {
    const fn: unknown = (target as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new LocatorSyntaxError(text, `${method}() is not available here`);
    target = (fn as (...a: Value[]) => Page | Locator | FrameLocator).apply(target, args);
  }
  if (target === page || typeof (target as Locator).click !== "function") {
    throw new LocatorSyntaxError(text, "does not end in an element locator");
  }
  return target as Locator;
}

class Parser {
  readonly #text: string;
  #pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  calls(): { method: string; args: Value[] }[] {
    const calls: { method: string; args: Value[] }[] = [];
    do {
      const method = this.#identifier();
      if (!METHODS.has(method)) this.#fail(`${method}() is not allowed`);
      this.#expect("(");
      const args: Value[] = [];
      this.#space();
      while (this.#peek() !== ")") {
        args.push(this.#value());
        this.#space();
        if (this.#peek() === ",") this.#pos++;
        this.#space();
      }
      this.#expect(")");
      calls.push({ method, args });
    } while (this.#accept("."));
    this.#space();
    if (this.#pos !== this.#text.length) this.#fail("unexpected text at the end");
    return calls;
  }

  #value(): Value {
    this.#space();
    const char = this.#peek();
    if (char === "'" || char === '"' || char === "`") return this.#string(char);
    if (char === "/") return this.#regex();
    if (char === "{") return this.#object();
    if (char !== undefined && /[-\d]/.test(char)) return this.#number();
    const word = this.#identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    return this.#fail(`unexpected ${JSON.stringify(word)}`);
  }

  #string(quote: string): string {
    this.#pos++;
    let out = "";
    while (true) {
      const char = this.#text[this.#pos++];
      if (char === undefined) this.#fail("unterminated string");
      if (char === quote) return out;
      if (char === "\\") {
        const next = this.#text[this.#pos++];
        if (next === undefined) this.#fail("unterminated string");
        out += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[next] ?? next;
      } else {
        out += char;
      }
    }
  }

  #regex(): RegExp {
    this.#pos++;
    let source = "";
    let inClass = false;
    while (true) {
      const char = this.#text[this.#pos++];
      if (char === undefined) this.#fail("unterminated regular expression");
      if (char === "/" && !inClass) break;
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      source += char;
      if (char === "\\") source += this.#text[this.#pos++] ?? "";
    }
    const flags = /^[dgimsuvy]*/.exec(this.#text.slice(this.#pos))?.[0] ?? "";
    this.#pos += flags.length;
    try {
      return new RegExp(source, flags);
    } catch {
      return this.#fail("invalid regular expression");
    }
  }

  #object(): { [key: string]: Value } {
    this.#expect("{");
    const out: { [key: string]: Value } = {};
    this.#space();
    while (this.#peek() !== "}") {
      const key =
        this.#peek() === "'" || this.#peek() === '"' ? this.#string(this.#peek() as string) : this.#identifier();
      this.#expect(":");
      out[key] = this.#value();
      this.#space();
      if (this.#peek() === ",") this.#pos++;
      this.#space();
    }
    this.#expect("}");
    return out;
  }

  #number(): number {
    const match = /^-?\d+(\.\d+)?/.exec(this.#text.slice(this.#pos));
    if (match === null) return this.#fail("invalid number");
    this.#pos += match[0].length;
    return Number(match[0]);
  }

  #identifier(): string {
    this.#space();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.#text.slice(this.#pos));
    if (match === null) return this.#fail("expected a name");
    this.#pos += match[0].length;
    return match[0];
  }

  #expect(char: string): void {
    if (!this.#accept(char)) this.#fail(`expected "${char}"`);
  }

  #accept(char: string): boolean {
    this.#space();
    if (this.#peek() !== char) return false;
    this.#pos++;
    return true;
  }

  #peek(): string | undefined {
    return this.#text[this.#pos];
  }

  #space(): void {
    while (this.#peek() !== undefined && /\s/.test(this.#peek() as string)) this.#pos++;
  }

  #fail(reason: string): never {
    throw new LocatorSyntaxError(this.#text, `${reason} at position ${this.#pos}`);
  }
}

/**
 * Finds the element of a recorded action by its durable locator, waiting up to `timeoutMs` for it to appear.
 * Returns the locator, or why the element cannot be found (the site drifted since the recording).
 */
export async function findElement(page: Page, text: string | undefined, timeoutMs: number): Promise<Locator | string> {
  if (text === undefined) return "no locator was recorded for this element";
  let locator: Locator;
  try {
    locator = parseLocator(page, text).first();
  } catch (error) {
    return (error as Error).message;
  }
  try {
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    return `element not found: ${text}`;
  }
  return locator;
}
