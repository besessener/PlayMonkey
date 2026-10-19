import type { Action } from "../monkey/actions.ts";
import type { UrlScope } from "../monkey/scope.ts";
import { type Decision, LlmError } from "./provider.ts";

export interface NavigationLimits {
  /** Origin the run must stay on, or undefined when `stayOnDomain` is off. */
  origin?: string | undefined;
  /** URLs the run may open; absent when `scope` is not restricted. */
  scope?: UrlScope | undefined;
}

/**
 * Checks what the provider cannot know: navigation targets, resolved against the page. Returns undefined for `done`;
 * throws `LlmError` `invalid` for a target the run must not open.
 */
export function acceptDecision(decision: Decision, pageUrl: string, limits: NavigationLimits): Action | undefined {
  if (decision.type === "done") return undefined;
  if (decision.type !== "navigate") return decision;
  let target: URL;
  try {
    target = new URL(decision.url, pageUrl);
  } catch {
    throw new LlmError("invalid", "tool navigate: url is not a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new LlmError("invalid", "tool navigate: only http(s) URLs are allowed");
  }
  if (limits.origin !== undefined && target.origin !== limits.origin) {
    throw new LlmError("invalid", "tool navigate: the URL leaves the site under test (stayOnDomain)");
  }
  if (limits.scope !== undefined && !limits.scope.allows(target.href)) {
    throw new LlmError("invalid", "tool navigate: the URL is outside the configured scope");
  }
  return { type: "navigate", url: target.href };
}
