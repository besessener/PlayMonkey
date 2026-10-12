/** Everything the monkey (and later the LLM) can do. Element actions name a ref from the current snapshot. */
export type Action =
  | { type: "click"; ref: string }
  | { type: "fill"; ref: string; value: string }
  | { type: "select"; ref: string; value: string }
  | { type: "check"; ref: string }
  | { type: "uncheck"; ref: string }
  | { type: "press"; key: string }
  | { type: "scroll"; deltaY: number }
  | { type: "back" }
  | { type: "navigate"; url: string }
  | { type: "setViewport"; width: number; height: number }
  | { type: "switchTab"; index: number };

export type ElementAction = Extract<Action, { ref: string }>;

export function isElementAction(action: Action): action is ElementAction {
  return "ref" in action;
}

/** One line for logs, e.g. `fill e8 "abc"`. Values are shortened; they may still contain test data. */
export function describeAction(action: Action): string {
  const value = (text: string) => JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
  switch (action.type) {
    case "click":
    case "check":
    case "uncheck":
      return `${action.type} ${action.ref}`;
    case "fill":
    case "select":
      return `${action.type} ${action.ref} ${value(action.value)}`;
    case "press":
      return `press ${action.key}`;
    case "scroll":
      return `scroll ${action.deltaY}`;
    case "back":
      return "back";
    case "navigate":
      return `navigate ${action.url}`;
    case "setViewport":
      return `setViewport ${action.width}x${action.height}`;
    case "switchTab":
      return `switchTab ${action.index}`;
  }
}
