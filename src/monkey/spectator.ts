/**
 * Spectator mode (`--watch`): a visible browser, slowed down, that outlines each element before acting on it, for
 * watching a run live or demonstrating it. It changes timing only, never what the monkey or the LLM chooses.
 */
export interface Spectator {
  /** Playwright's `slowMo`: delay before every browser operation, in milliseconds. */
  slowMoMs: number;
  /** How long the target element stays outlined before the action, in milliseconds. */
  highlightMs: number;
}

export const DEFAULT_SPECTATOR: Spectator = { slowMoMs: 250, highlightMs: 600 };

/** The outline drawn around the target element; Playwright's own overlay, removed again before the action. */
export const HIGHLIGHT_STYLE = "outline: 3px solid #f97316; outline-offset: 2px; background: rgb(249 115 22 / 0.15);";
