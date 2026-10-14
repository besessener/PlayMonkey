/** What the state- and event-based oracles look for in pages and messages. */

/** Title or main heading of a page that is an error page, whatever its status. */
export const ERROR_PAGE_PATTERNS = [
  /\bnot found\b/i,
  /\b(internal )?server error\b/i,
  /\bsomething went wrong\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\baccess denied\b/i,
  /\bforbidden\b/i,
  /\b(an|unexpected) error (has )?occurred\b/i,
  /^\s*(error\s*)?[45]\d\d\b/i,
];

/** Chromium's console echo of a failed HTTP response: the response itself is the HTTP oracles' business. */
export const FAILED_RESOURCE = /^Failed to load resource: the server responded with a status of (\d{3})\b/;
/** Chromium's echo of a request the `offline` action made fail: caused by the monkey, not the page. */
export const OFFLINE_RESOURCE = /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED\b/;

/** Failed navigations that are not the site's fault: aborted by the guard or a newer navigation, or made offline. */
export const IGNORED_NAVIGATION_FAILURES = new Set(["net::ERR_ABORTED", "net::ERR_INTERNET_DISCONNECTED"]);

export interface PageFacts {
  scrollWidth: number;
  clientWidth: number;
  title: string;
  heading: string;
  /** The outermost element sticking out on the right, e.g. `div.banner`. */
  culprit: string;
}

/**
 * Evaluated in the page (a string, because `src` has no DOM types). For overflow, the culprit is the first element in
 * document order that sticks out on the right while its parent does not.
 */
export const READ_PAGE_FACTS = `(() => {
  const root = document.documentElement;
  const width = root.clientWidth;
  let culprit = "document";
  if (root.scrollWidth > width && document.body !== null) {
    const right = (element) => element.getBoundingClientRect().right + window.scrollX;
    for (const element of document.body.querySelectorAll("*")) {
      if (right(element) <= width + 1) continue;
      const parent = element.parentElement;
      if (parent === null || parent === document.body || right(parent) <= width + 1) {
        const id = element.id === "" ? "" : "#" + element.id;
        const classes = [...element.classList].slice(0, 2).map((name) => "." + name).join("");
        culprit = element.localName + id + classes;
        break;
      }
    }
  }
  return {
    scrollWidth: root.scrollWidth,
    clientWidth: width,
    title: document.title,
    heading: document.querySelector("h1")?.textContent?.trim() ?? "",
    culprit,
  };
})()`;

/** Attribute that marks the form fields a finding screenshot blacks out. */
export const SECRET_FIELD = "data-monkey-secret";

/**
 * Evaluated in the page before a finding screenshot: marks every password field and every field whose value contains
 * one of `values`, and returns how many it marked.
 */
export function markSecretFields(values: string[]): string {
  return `(() => {
  const values = ${JSON.stringify(values)};
  let marked = 0;
  for (const field of document.querySelectorAll("input, textarea")) {
    if (field.type !== "password" && !values.some((value) => field.value.includes(value))) continue;
    field.setAttribute("${SECRET_FIELD}", "");
    marked++;
  }
  return marked;
})()`;
}

export const UNMARK_SECRET_FIELDS = `(() => {
  for (const field of document.querySelectorAll("[${SECRET_FIELD}]")) field.removeAttribute("${SECRET_FIELD}");
})()`;
