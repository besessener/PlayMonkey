import type { Config } from "../config/config.ts";

/** The compiled `scope` of a config: which URLs the monkey may open. */
export class UrlScope {
  readonly #allow: RegExp[];
  readonly #deny: RegExp[];

  constructor(scope: Config["scope"]) {
    this.#allow = scope.allow.map((pattern) => new RegExp(pattern));
    this.#deny = scope.deny.map((pattern) => new RegExp(pattern));
  }

  /** True when the config restricts URLs at all. */
  get restricted(): boolean {
    return this.#allow.length > 0 || this.#deny.length > 0;
  }

  /** True when the absolute `url` may be opened. */
  allows(url: string): boolean {
    return (this.#allow.length === 0 || this.#allow.some((p) => p.test(url))) && !this.#deny.some((p) => p.test(url));
  }

  /** Like `allows`, for a link target relative to `pageUrl`; links that are not URLs (`javascript:`) are allowed. */
  allowsLink(href: string, pageUrl: string): boolean {
    let target: URL;
    try {
      target = new URL(href, pageUrl);
    } catch {
      return true;
    }
    return !/^https?:$/.test(target.protocol) || this.allows(target.href);
  }
}
