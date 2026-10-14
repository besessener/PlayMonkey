/**
 * Dedup keys. Two signals with the same key are one finding. Keys leave out what changes between occurrences of the
 * same bug (ids and numbers in URLs and messages, query strings, the port of the site under test) so they are also
 * stable between a run and its replay.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Hex runs of 8+ characters with at least one digit: hashes, object ids, cache busters.
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)]+/g;
// CSP sources that differ per page load or per inline script: nonces and script hashes.
const CSP_NONCE = /\bnonce-[A-Za-z0-9+/_=-]+/g;
const CSP_HASH = /\bsha(?:256|384|512)-[A-Za-z0-9+/_=-]+/g;
// Base64-ish tokens and JWT parts; only with a digit and a lowercase letter, so `ERR_HTTP2_…` constants stay.
const TOKEN = /[A-Za-z0-9+/_=-]{16,}/g;
// Content hashes in file names: 8+ word characters with a digit after `-`, `.` or the segment start, before a dot.
const ASSET_HASH = /(^|[-.])(?=\w*\d)\w{8,}(?=\.)/g;
// A frame location: a URL with a scheme, then line and column; built-in frames like `<anonymous>` have none.
const LOCATION = String.raw`([a-z][\w+.-]*:\S+?)(:\d+:\d+)`;
const V8_FRAME = new RegExp(String.raw`^at\s(?:async\s)?(?:.*\()?${LOCATION}\)?$`, "i");
const GECKO_FRAME = new RegExp(`^[^@]*@${LOCATION}$`, "i");

/**
 * A URL without query, fragment and ids: numeric path segments become `:n`, uuids and other id-like segments `:id`,
 * content hashes in file names `:hash`. The origin is dropped when it is `origin` (the site under test), so keys
 * survive a change of host or port.
 */
export function normalizeUrl(url: string, origin?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === "blob:") return `blob:${normalizeUrl(parsed.pathname, origin)}`;
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
  return segment.replace(ASSET_HASH, "$1:hash");
}

/** A message with URLs normalized, ids and tokens replaced by `:id`, numbers by `#` and whitespace collapsed. */
export function normalizeMessage(text: string, origin?: string): string {
  // URLs are normalized on their own, so their digits are not replaced like the rest of the text.
  const parts = text.split(URL_IN_TEXT);
  const urls = text.match(URL_IN_TEXT) ?? [];
  const out = parts
    .map((part, index) => {
      const url = urls[index];
      return url === undefined ? normalizeText(part) : `${normalizeText(part)}${normalizeUrl(url, origin)}`;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > 300 ? out.slice(0, 300) : out;
}

function normalizeText(text: string): string {
  return text
    .replace(UUID, ":id")
    .replace(CSP_NONCE, "nonce-:id")
    .replace(CSP_HASH, ":hash")
    .replace(TOKEN, (token) => (/\d/.test(token) && /[a-z]/.test(token) ? ":id" : token))
    .replace(HEX_ID, ":id")
    .replace(/\d+/g, "#");
}

/**
 * The first frame of a stack trace that has a URL, with the URL normalized, keeping line and column: the same message
 * thrown from two places is two bugs. Understands V8 (`at fn (url:1:2)`) and Firefox/WebKit (`fn@url:1:2`) frames.
 * `header` is the `Name: message` line V8 puts before the frames; it is skipped, even when the message spans lines.
 */
export function firstStackFrame(stack: string | undefined, origin?: string, header?: string): string {
  const text = stack ?? "";
  const frames = header !== undefined && text.startsWith(header) ? text.slice(header.length) : text;
  for (const line of frames.split("\n")) {
    const trimmed = line.trim();
    const match = V8_FRAME.exec(trimmed) ?? GECKO_FRAME.exec(trimmed);
    if (match === null) continue;
    const [, url = "", position = ""] = match;
    const at = trimmed.lastIndexOf(`${url}${position}`);
    return `${trimmed.slice(0, at)}${normalizeUrl(url, origin)}${trimmed.slice(at + url.length)}`;
  }
  return "";
}
