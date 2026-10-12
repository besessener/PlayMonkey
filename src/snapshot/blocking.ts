import type { Snapshot, SnapshotElement } from "./snapshot.ts";

/** Text that suggests a cookie or consent banner, when a button to answer it is present too. */
const CONSENT_TEXT = /\b(cookies?|consent|tracking|datenschutz|privacy (settings|preferences))\b/i;
const CONSENT_BUTTON = /\b(accept|agree|allow|got it|ok|reject|decline|akzeptieren|zustimmen|erlauben|ablehnen)\b/i;

/** Why the page is blocked, or undefined: an open dialog, or a cookie or consent banner. */
export function blockingUi(snapshot: Snapshot): string | undefined {
  if (snapshot.dialogs.length > 0) {
    const name = snapshot.dialogs[0] as string;
    return name === "" ? "a dialog is open" : `a dialog is open: ${JSON.stringify(name)}`;
  }
  if (CONSENT_TEXT.test(snapshot.text) && snapshot.elements.some(isConsentButton)) {
    return "a cookie or consent banner seems to be showing";
  }
  return undefined;
}

/**
 * Elements that answer what blocks the page: everything inside an open dialog, or the buttons of a consent banner.
 * Empty when nothing blocks the page. Overlays usually cover the rest of the page, so clicks elsewhere fail.
 */
export function unblockingElements(snapshot: Snapshot): Set<SnapshotElement> {
  if (snapshot.dialogs.length > 0) return new Set(snapshot.elements.filter((element) => element.inDialog === true));
  if (!CONSENT_TEXT.test(snapshot.text)) return new Set();
  return new Set(snapshot.elements.filter(isConsentButton));
}

function isConsentButton(element: SnapshotElement): boolean {
  return element.role === "button" && CONSENT_BUTTON.test(element.name);
}
