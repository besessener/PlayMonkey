/**
 * Seeded pseudo-random generator: sfc32, seeded through splitmix32. Small, fast and well distributed; the same seed
 * always yields the same sequence on every platform (only 32-bit integer arithmetic). Never use `Math.random`.
 */
export class Random {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number) {
    let state = seed >>> 0;
    const splitmix = () => {
      state = (state + 0x9e3779b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.#a = splitmix();
    this.#b = splitmix();
    this.#c = splitmix();
    this.#d = splitmix();
    for (let i = 0; i < 12; i++) this.next(); // discard the warm-up outputs
  }

  /** A float in [0, 1). */
  next(): number {
    const t = (((this.#a + this.#b) >>> 0) + this.#d) >>> 0;
    this.#d = (this.#d + 1) >>> 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) >>> 0;
    this.#c = ((this.#c << 21) | (this.#c >>> 11)) >>> 0;
    this.#c = (this.#c + t) >>> 0;
    return t / 4294967296;
  }

  /** An integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** A uniformly chosen item; throws on an empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[this.int(items.length)] as T;
  }

  /** An item chosen with probability proportional to its weight; items with weight 0 are never chosen. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const weights = items.map(weight);
    const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
    if (total <= 0) throw new Error("weighted pick without positive weights");
    let point = this.next() * total;
    for (const [index, item] of items.entries()) {
      point -= Math.max(0, weights[index] ?? 0);
      if (point < 0) return item;
    }
    return items[items.length - 1] as T;
  }
}
