import type { Frame, Page } from "playwright";
import { secretForms } from "../config/secrets.ts";
import { TIMEOUT, withTimeout } from "../monkey/timeout.ts";
import { firstLine } from "./prompt.ts";
import type { Screenshot } from "./provider.ts";

/** Attribute that marks what a screenshot for the LLM hides. */
const HIDE = "data-monkey-hide";

/** A screenshot with every secret hidden, or why there is none. */
export type Capture = { ok: true; screenshot: Screenshot; hidden: number } | { ok: false; reason: string };

export interface CaptureOptions {
  /** Secret values; each is hidden in all its forms (`secretForms`). Password fields are hidden without them too. */
  secrets: readonly string[];
  /** For every page call: marking each frame, the screenshot, unmarking. */
  timeoutMs: number;
}

/**
 * Evaluated in every frame: marks password fields, fields whose value or placeholder holds a secret, selects showing
 * one, and the innermost elements whose text holds one (also in open shadow roots, and split across child elements).
 * Returns how many it marked.
 */
function markScript(values: readonly string[]): string {
  return `(() => {
  const values = ${JSON.stringify(values)};
  const has = (text) => typeof text === "string" && text !== "" && values.some((value) => text.includes(value));
  const innermost = (children) => ![...children].some((child) => has(child.textContent));
  let marked = 0;
  const mark = (element) => {
    if (element.hasAttribute("${HIDE}")) return;
    element.setAttribute("${HIDE}", "");
    marked++;
  };
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      const shadow = element.shadowRoot;
      if (shadow !== null) {
        visit(shadow);
        if (has(shadow.textContent) && innermost(shadow.children)) mark(element);
      }
      const name = element.localName;
      if (name === "input" || name === "textarea") {
        if (element.type === "password" || has(element.value) || has(element.placeholder)) mark(element);
      } else if (name === "select") {
        if ([...element.selectedOptions].some((option) => has(option.text))) mark(element);
      } else if (has(element.textContent) && innermost(element.children)) mark(element);
    }
  };
  visit(document);
  return marked;
})()`;
}

const UNMARK = `(() => {
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot !== null) visit(element.shadowRoot);
      element.removeAttribute("${HIDE}");
    }
  };
  visit(document);
})()`;

/** Hides marked elements and their content, also text that overflows the element's box, which a mask would miss. */
const HIDE_STYLE = `[${HIDE}], [${HIDE}] * { visibility: hidden !important; }`;

/**
 * A JPEG of the viewport for the LLM with every secret blacked out, or none. Every frame must be checked for secrets
 * in time and no frame may appear meanwhile; otherwise there is no screenshot, never one that might show a secret.
 * Pixels the page draws itself (canvas, images, closed shadow roots) cannot be checked.
 */
export async function maskedScreenshot(page: Page, options: CaptureOptions): Promise<Capture> {
  if (page.isClosed()) return { ok: false, reason: "the page is closed" };
  const values = [...new Set(options.secrets.flatMap((value) => secretForms(value)))].filter((value) => value !== "");
  const frames = page.frames();
  try {
    let hidden = 0;
    for (const frame of frames) {
      const marked = await mark(frame, values, options.timeoutMs);
      if (marked === undefined) return { ok: false, reason: "a frame could not be checked for secrets in time" };
      hidden += marked;
    }
    const shot = await withTimeout(
      page.screenshot({
        type: "jpeg",
        quality: 70,
        timeout: options.timeoutMs,
        mask: frames.map((frame) => frame.locator(`[${HIDE}]`)),
        maskColor: "#000000",
        style: HIDE_STYLE,
      }),
      options.timeoutMs,
    );
    if (shot === TIMEOUT) return { ok: false, reason: "the screenshot did not finish in time" };
    if (page.frames().some((frame) => !frames.includes(frame))) {
      return { ok: false, reason: "a frame appeared while the secrets were hidden" };
    }
    return { ok: true, hidden, screenshot: { mediaType: "image/jpeg", data: shot.toString("base64") } };
  } catch (error) {
    return {
      ok: false,
      reason: `the screenshot failed: ${firstLine(error instanceof Error ? error.message : String(error))}`,
    };
  } finally {
    await Promise.all(
      frames.map((frame) => withTimeout(frame.evaluate(UNMARK), options.timeoutMs).catch(() => undefined)),
    );
  }
}

/** How many elements were marked in the frame, or undefined when it did not answer in time. */
async function mark(frame: Frame, values: readonly string[], timeoutMs: number): Promise<number | undefined> {
  const marked = await withTimeout(frame.evaluate<number>(markScript(values)), timeoutMs).catch(() => undefined);
  return marked === TIMEOUT ? undefined : marked;
}
