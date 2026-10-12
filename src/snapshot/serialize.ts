import type { Snapshot, SnapshotElement } from "./snapshot.ts";

export interface SerializeOptions {
  /** Upper bound for the output length in characters (roughly four per token). Default 8000. */
  maxChars?: number;
  /** Longest name or text value shown per element. Default 100. */
  maxNameChars?: number;
}

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_NAME_CHARS = 100;
/** Share of the budget the page text may use when elements need the rest. */
const TEXT_SHARE = 0.25;

/**
 * Renders a snapshot for an LLM prompt within a character budget. Elements in the viewport come first, then the
 * rest in document order; long names and text are shortened, and every omission is stated in the output.
 */
export function serializeSnapshot(snapshot: Snapshot, options: SerializeOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxName = options.maxNameChars ?? DEFAULT_MAX_NAME_CHARS;

  const header = [`URL: ${snapshot.url}`, `Title: ${shorten(snapshot.title, maxName)}`];
  if (snapshot.crossOriginFrames > 0) {
    header.push(`Cross-origin frames (not entered): ${snapshot.crossOriginFrames}`);
  }
  if (snapshot.dialogs.length > 0) {
    header.push(`Open dialogs: ${snapshot.dialogs.map((name) => JSON.stringify(shorten(name, maxName))).join(", ")}`);
  }

  const ordered = [
    ...snapshot.elements.filter((element) => element.inViewport),
    ...snapshot.elements.filter((element) => !element.inViewport),
  ];
  const textBudget = Math.floor(maxChars * TEXT_SHARE);
  // Reserve room for the section headings and omission notes.
  let remaining = maxChars - length(header) - Math.min(textBudget, snapshot.text.length) - 200;

  const lines: string[] = [];
  for (const element of ordered) {
    const line = describe(element, maxName);
    if (line.length + 1 > remaining) break;
    lines.push(line);
    remaining -= line.length + 1;
  }
  const omitted = ordered.length - lines.length;

  const out = [...header, "", `Elements (${lines.length} of ${ordered.length}):`, ...lines];
  if (omitted > 0) out.push(`[${omitted} more elements omitted to fit the budget]`);

  const textRoom = Math.max(0, maxChars - length(out) - 60);
  if (snapshot.text !== "" && textRoom > 0) {
    const text = snapshot.text.length > textRoom ? `${snapshot.text.slice(0, textRoom)}…` : snapshot.text;
    out.push("", "Text:", text);
    if (text.length < snapshot.text.length) out.push(`[text truncated, ${snapshot.text.length} characters in total]`);
  }
  const result = out.join("\n");
  return result.length <= maxChars ? result : `${result.slice(0, maxChars - 1)}…`;
}

function describe(element: SnapshotElement, maxName: number): string {
  const parts = [element.ref, element.role];
  if (element.name !== "") parts.push(JSON.stringify(shorten(element.name, maxName)));
  if (element.url !== undefined) parts.push(`-> ${shorten(element.url, maxName)}`);
  if (element.placeholder !== undefined)
    parts.push(`placeholder=${JSON.stringify(shorten(element.placeholder, maxName))}`);
  if (element.options !== undefined) {
    parts.push(`options=${JSON.stringify(element.options.map((option) => shorten(option, 40)).slice(0, 20))}`);
  }
  if (element.checked !== undefined) parts.push(`checked=${element.checked}`);
  if (element.expanded !== undefined) parts.push(`expanded=${element.expanded}`);
  if (!element.enabled) parts.push("disabled");
  if (element.inFrame) parts.push("(in frame)");
  if (element.inDialog === true) parts.push("(in dialog)");
  return parts.join(" ");
}

function shorten(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function length(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}
