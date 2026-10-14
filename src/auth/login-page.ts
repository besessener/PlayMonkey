import type { Snapshot } from "../snapshot/snapshot.ts";

const PASSWORD_FIELD = /\b(password|passwort|kennwort|passphrase)\b/i;
const LOGIN_BUTTON = /\b(log ?in|sign ?in|anmelden|einloggen)\b/i;

/**
 * True when the snapshot looks like a login page: its path is that of `loginUrl` (absolute, of a form-login role), or
 * it has a password textbox and a login button or link.
 */
export function isLoginPage(snapshot: Snapshot, loginUrl?: string): boolean {
  if (loginUrl !== undefined && pathOf(snapshot.url) === pathOf(loginUrl)) return true;
  const password = snapshot.elements.some((e) => e.role === "textbox" && PASSWORD_FIELD.test(e.name));
  const button = snapshot.elements.some((e) => (e.role === "button" || e.role === "link") && LOGIN_BUTTON.test(e.name));
  return password && button;
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
