import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";

/** One node of Playwright's AI-mode aria snapshot (`page.ariaSnapshotJSON({ mode: "ai" })`). */
interface AriaNode {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  cursor?: string;
  url?: string;
  placeholder?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  box?: { x: number; y: number; width: number; height: number };
  children?: (AriaNode | string)[];
}

/** Roles the monkey can act on; anything else counts only when the page marks it clickable (`cursor: pointer`). */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const DIALOG_ROLES = new Set(["dialog", "alertdialog"]);

const CHECKABLE_ROLES = new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "radio", "switch"]);

/** Keys that identify an element in one snapshot only, or change without the page's state changing. */
const VOLATILE_KEYS = new Set(["ref", "box", "active", "cursor"]);

export interface SnapshotElement {
  /** Valid until the next snapshot of the same page; resolve it with `resolve`. */
  ref: string;
  role: string;
  name: string;
  /** Link target, as written in the page. */
  url?: string;
  placeholder?: string;
  /** Option names of a combobox or listbox. */
  options?: string[];
  checked?: boolean | "mixed";
  expanded?: boolean;
  enabled: boolean;
  /** At least partly inside the viewport. */
  inViewport: boolean;
  /** Inside a same-origin iframe rather than the top-level document. */
  inFrame: boolean;
  /** Inside an open dialog (`dialog`, `alertdialog`); absent otherwise. */
  inDialog?: true;
}

export interface Snapshot {
  url: string;
  title: string;
  /** Actionable elements in document order, including open shadow DOM and same-origin iframes. */
  elements: SnapshotElement[];
  /** Visible static text in document order. */
  text: string;
  /** Number of cross-origin iframes: listed, not entered. */
  crossOriginFrames: number;
  /** Accessible names of open dialogs (`dialog`, `alertdialog`), in document order; `""` for an unnamed one. */
  dialogs: string[];
  /** Stable for an unchanged page, different after a state change. Independent of refs and layout. */
  hash: string;
}

/** The ref no longer points to an element: the page changed since the snapshot. */
export class StaleRefError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(`element ${ref} is gone; take a new snapshot`);
    this.name = "StaleRefError";
    this.ref = ref;
  }
}

/**
 * Takes a snapshot of the page's top-level document, open shadow roots and iframes. `timeoutMs` bounds the aria
 * snapshot; the other page calls have no timeout of their own, so callers bound the whole call as well.
 */
export async function snapshot(page: Page, timeoutMs?: number): Promise<Snapshot> {
  const roots = (await page.ariaSnapshotJSON({
    mode: "ai",
    boxes: true,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  })) as (AriaNode | string)[];
  const viewport =
    page.viewportSize() ??
    (await page.evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })"));
  const origin = new URL(page.url()).origin;

  const walk: Walk = { page, origin, viewport, elements: [], texts: [], dialogs: [], crossOriginFrames: 0 };
  for (const root of roots) await visit(walk, root, { inFrame: false, inDialog: false });

  return {
    url: page.url(),
    title: await page.title(),
    elements: walk.elements,
    text: walk.texts
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .join("\n"),
    crossOriginFrames: walk.crossOriginFrames,
    dialogs: walk.dialogs,
    hash: hashTree(roots),
  };
}

/**
 * Returns a locator for a ref of the latest snapshot, or throws `StaleRefError` at once (Playwright would wait).
 * Any other aria snapshot of the page, including `locator.ariaSnapshot()`, replaces the refs.
 */
export async function resolve(page: Page, ref: string): Promise<Locator> {
  const locator = page.getByRef(ref);
  if ((await locator.count()) !== 1) throw new StaleRefError(ref);
  return locator;
}

/**
 * A locator for the element that survives page loads, such as `getByRole('button', { name: 'Send' })`, chosen by
 * Playwright like `codegen` does. Used for the action log, since refs are only valid for one snapshot.
 */
export async function durableLocator(page: Page, ref: string): Promise<string> {
  return (await (await resolve(page, ref)).normalize()).toString();
}

/** What a snapshot collects while it walks the aria tree. */
interface Walk {
  page: Page;
  origin: string;
  viewport: { width: number; height: number };
  elements: SnapshotElement[];
  texts: string[];
  dialogs: string[];
  crossOriginFrames: number;
}

/** Where a node sits: inside a same-origin iframe, inside an open dialog. */
interface Placement {
  inFrame: boolean;
  inDialog: boolean;
}

async function visit(walk: Walk, node: AriaNode | string, placement: Placement): Promise<void> {
  if (typeof node === "string") {
    walk.texts.push(node);
    return;
  }
  if (node.role === "iframe") {
    await visitFrame(walk, node, placement);
    return;
  }
  const isDialog = DIALOG_ROLES.has(node.role);
  if (isDialog) walk.dialogs.push(node.name ?? "");
  collect(walk, node, placement);
  if (node.role === "combobox" || node.role === "listbox") return; // options belong to the element
  const inDialog = placement.inDialog || isDialog;
  for (const child of node.children ?? []) await visit(walk, child, { inFrame: placement.inFrame, inDialog });
}

/** Enters a same-origin iframe; a cross-origin one is only counted. */
async function visitFrame(walk: Walk, node: AriaNode, placement: Placement): Promise<void> {
  if (node.ref !== undefined && !(await isSameOrigin(walk.page, node.ref, walk.origin))) {
    walk.crossOriginFrames++;
    return;
  }
  for (const child of node.children ?? []) await visit(walk, child, { inFrame: true, inDialog: placement.inDialog });
}

/** Records the node as an element when it is actionable, and its text. */
function collect(walk: Walk, node: AriaNode, placement: Placement): void {
  if (node.ref !== undefined && isActionable(node))
    walk.elements.push(toElement(node, node.ref, walk.viewport, placement));
  // Headings and other named landmarks carry their text as the name.
  else if (node.name !== undefined && node.role !== "option") walk.texts.push(node.name);
  if (node.text !== undefined && node.role !== "option") walk.texts.push(node.text);
}

function isActionable(node: AriaNode): boolean {
  if (node.role === "option") return false; // reached through its combobox or listbox
  return INTERACTIVE_ROLES.has(node.role) || node.cursor === "pointer";
}

function toElement(
  node: AriaNode,
  ref: string,
  viewport: { width: number; height: number },
  { inFrame, inDialog }: Placement,
): SnapshotElement {
  const element: SnapshotElement = {
    ref,
    role: node.role,
    name: node.name ?? "",
    enabled: node.disabled !== true,
    inViewport: intersects(node.box, viewport),
    inFrame,
  };
  if (inDialog) element.inDialog = true;
  if (node.url !== undefined) element.url = node.url;
  if (node.placeholder !== undefined) element.placeholder = node.placeholder;
  if (node.checked !== undefined) element.checked = node.checked;
  else if (CHECKABLE_ROLES.has(node.role)) element.checked = false; // the snapshot omits unchecked state
  if (node.expanded !== undefined) element.expanded = node.expanded;
  if (node.role === "combobox" || node.role === "listbox") {
    element.options = (node.children ?? []).flatMap((child) =>
      typeof child !== "string" && child.role === "option" ? [child.name ?? ""] : [],
    );
  }
  return element;
}

function intersects(box: AriaNode["box"], viewport: { width: number; height: number }): boolean {
  if (box === undefined || box.width <= 0 || box.height <= 0) return false;
  return box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0;
}

async function isSameOrigin(page: Page, iframeRef: string, origin: string): Promise<boolean> {
  try {
    const frame = await (await page.getByRef(iframeRef).elementHandle({ timeout: 1000 }))?.contentFrame();
    const url = frame?.url();
    // srcdoc and about:blank frames inherit the parent's origin.
    if (url === undefined || url === "" || url.startsWith("about:")) return true;
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function hashTree(roots: (AriaNode | string)[]): string {
  const canonical = JSON.stringify(roots, (key, value: unknown) => {
    if (VOLATILE_KEYS.has(key)) return;
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
