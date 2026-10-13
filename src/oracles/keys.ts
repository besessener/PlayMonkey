/**
 * Dedup keys. Two signals with the same key are one finding. Keys leave out what changes between occurrences of the
 * same bug (ids and numbers in URLs and messages, query strings, the port of the site under test) so they are also
 * stable between a run and its replay.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Hex runs of 8+ characters with at least one digit: hashes, object ids, cache busters.
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)]+/g;

/**
 * A URL without query, fragment and ids: numeric path segments become `:n`, uuids and other id-like segments `:id`.
 * The origin is dropped when it is `origin` (the site under test), so keys survive a change of host or port.
 */
export function normalizeUrl(url: string, origin?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return `${parsed.protocol}${parsed.pathname.slice(0, 100)}`;
  const path = parsed.pathname
    .split("/")
    .map((segment) => normalizeSegment(segment))
    .join("/");
  return parsed.origin === origin ? path : `${parsed.origin}${path}`;
}

function normalizeSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return ":n";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
  if (/^(?=[0-9a-f]*\d)[0-9a-f]{8,}$/i.test(segment)) return ":id";
  // Long tokens mixing letters and digits, e.g. base64 ids or session tokens.
  if (segment.length >= 16 && /\d/.test(segment) && /[a-z]/i.test(segment) && /^[\w-]+$/.test(segment)) return ":id";
  return segment;
}

/** A message with URLs normalized, ids replaced by `:id`, numbers by `#` and whitespace collapsed. */
export function normalizeMessage(text: string, origin?: string): string {
  // URLs are normalized on their own, so their digits are not replaced like the rest of the text.
  const parts = text.split(URL_IN_TEXT);
  const urls = text.match(URL_IN_TEXT) ?? [];
  const out = parts
    .map((part, index) => {
      const plain = part.replace(UUID, ":id").replace(HEX_ID, ":id").replace(/\d+/g, "#");
      const url = urls[index];
      return url === undefined ? plain : `${plain}${normalizeUrl(url, origin)}`;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > 300 ? out.slice(0, 300) : out;
}

/**
 * The first frame of a stack trace with its URL normalized, keeping line and column: the same message thrown from
 * two places is two bugs. Understands V8 (`at fn (url:1:2)`) and Firefox/WebKit (`fn@url:1:2`) frames.
 */
export function firstStackFrame(stack: string | undefined, origin?: string): string {
  for (const line of (stack ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!/^at\s|@/.test(trimmed)) continue;
    return trimmed.replace(
      /(https?:\/\/[^\s)]+?)(:\d+:\d+)?(?=\)|$)/,
      (_, url: string, position = "") => `${normalizeUrl(url, origin)}${position}`,
    );
  }
  return "";
}
