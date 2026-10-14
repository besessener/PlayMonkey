import type { Frame, Page, Request } from "playwright";

/**
 * Watches a page's main frame during one action: whether its document changed, and which navigation is still loading.
 * A navigation is loading from its request until the page's `load` event or the request's failure, so a click whose
 * navigation never commits counts as well as a committed document that never finishes loading. A navigation the page
 * cancelled (a dismissed `beforeunload` dialog) never sends a request and is not loading.
 */
export class NavigationWatch {
  /** The top-level document changed (navigation, reload or same-document navigation). */
  navigated = false;
  readonly #page: Page;
  #pending: Request | undefined;

  constructor(page: Page) {
    this.#page = page;
    page.on("request", this.#onRequest);
    page.on("requestfailed", this.#onRequestFailed);
    page.on("load", this.#onLoad);
    page.on("framenavigated", this.#onFrameNavigated);
  }

  /** The URL of the main-frame navigation that has not loaded yet, if any. */
  get loading(): string | undefined {
    return this.#pending?.url();
  }

  detach(): void {
    this.#page.off("request", this.#onRequest);
    this.#page.off("requestfailed", this.#onRequestFailed);
    this.#page.off("load", this.#onLoad);
    this.#page.off("framenavigated", this.#onFrameNavigated);
  }

  readonly #onRequest = (request: Request): void => {
    if (request.isNavigationRequest() && this.#isMainFrame(request)) this.#pending = request;
  };

  readonly #onRequestFailed = (request: Request): void => {
    if (request === this.#pending) this.#pending = undefined;
  };

  readonly #onLoad = (): void => {
    this.#pending = undefined;
  };

  readonly #onFrameNavigated = (frame: Frame): void => {
    if (frame.parentFrame() === null) this.navigated = true;
  };

  #isMainFrame(request: Request): boolean {
    try {
      return request.frame() === this.#page.mainFrame();
    } catch {
      return false;
    }
  }
}
