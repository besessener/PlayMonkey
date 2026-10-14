/** What `ddmin` found: the smallest failing subsequence it reached, and whether it stopped early. */
export interface MinimizeResult<T> {
  items: T[];
  /** Calls of `test`, cached repeats not counted. */
  tests: number;
  /** True when the budget or `stop` ended the search before the result was 1-minimal. */
  stoppedEarly: boolean;
}

export interface MinimizeOptions {
  /** Most calls of `test`; the search ends with the best result so far when they are used up. */
  maxTests: number;
  /** Checked before every test; true ends the search like the budget. */
  stop?: () => boolean;
}

/**
 * Zeller's delta debugging: shrinks `items`, which make `test` true, to a subsequence that still makes it true and
 * from which no single item can be removed (1-minimal), keeping the order. `items` itself is assumed to pass.
 */
export async function ddmin<T>(
  items: T[],
  test: (subset: T[]) => Promise<boolean>,
  options: MinimizeOptions,
): Promise<MinimizeResult<T>> {
  const search = new Search(test, options);
  let current = items;
  let parts = 2;
  while (current.length >= 2 && !search.exhausted()) {
    const next = await reduce(current, parts, search);
    if (next !== undefined) {
      current = next.items;
      parts = next.parts;
    } else if (search.exhausted()) {
      // The round may have been cut short, so `current` is not known to be 1-minimal.
      break;
    } else if (parts >= current.length) {
      return { items: current, tests: search.tests, stoppedEarly: false };
    } else {
      parts = Math.min(parts * 2, current.length);
    }
  }
  return { items: current, tests: search.tests, stoppedEarly: current.length >= 2 };
}

/** One round: the first chunk, else the first complement, that still passes, with the granularity to go on with. */
async function reduce<T>(
  current: T[],
  parts: number,
  search: Search<T>,
): Promise<{ items: T[]; parts: number } | undefined> {
  const chunks = split(current, parts);
  for (const chunk of chunks) {
    if (await search.passes(chunk)) return { items: chunk, parts: 2 };
  }
  // With two parts the complements are the chunks again.
  if (parts === 2) return undefined;
  for (const chunk of chunks) {
    const complement = current.filter((item) => !chunk.includes(item));
    if (await search.passes(complement)) return { items: complement, parts: Math.max(parts - 1, 2) };
  }
  return undefined;
}

/** `items` in `parts` contiguous chunks of nearly equal size. */
function split<T>(items: T[], parts: number): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  for (let index = 0; index < parts; index++) {
    const end = start + Math.floor((items.length - start) / (parts - index));
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/** The test with its budget and a cache, so a subset is never tried twice. */
class Search<T> {
  tests = 0;
  readonly #test: (subset: T[]) => Promise<boolean>;
  readonly #options: MinimizeOptions;
  readonly #seen = new Map<string, boolean>();
  readonly #items = new Map<T, number>();

  constructor(test: (subset: T[]) => Promise<boolean>, options: MinimizeOptions) {
    this.#test = test;
    this.#options = options;
  }

  exhausted(): boolean {
    return this.tests >= this.#options.maxTests || this.#options.stop?.() === true;
  }

  /** False without testing once the budget is used up. */
  async passes(subset: T[]): Promise<boolean> {
    const key = subset.map((item) => this.#id(item)).join(",");
    const known = this.#seen.get(key);
    if (known !== undefined) return known;
    if (this.exhausted()) return false;
    this.tests++;
    const result = await this.#test(subset);
    this.#seen.set(key, result);
    return result;
  }

  #id(item: T): number {
    let id = this.#items.get(item);
    if (id === undefined) {
      id = this.#items.size;
      this.#items.set(item, id);
    }
    return id;
  }
}
