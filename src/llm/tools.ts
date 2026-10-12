import { Ajv, type ValidateFunction } from "ajv";
import { type Decision, LlmError } from "./provider.ts";

/** A tool as every provider declares it: name, description and a strict JSON schema of its input. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export const KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "Space",
  "Backspace",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
] as const;

const ref = { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$", description: "Ref of an element, e.g. e12." };
const value = { type: "string", maxLength: 10_000 };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = Object.keys(properties),
): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

/**
 * One tool per action, in a fixed order so the definitions stay cache-friendly. Element tools take a ref from the
 * current snapshot; refs change with every snapshot.
 */
export const ACTION_TOOLS: readonly ToolDefinition[] = [
  tool("click", "Click an element (link, button or anything clickable) by its ref from the current snapshot.", {
    ref,
  }),
  tool(
    "fill",
    "Replace the content of a text field by its ref. The value may contain placeholders such as " +
      "{{testData.email}} or {{admin.password}}; they are replaced with the real value before typing.",
    { ref, value: { ...value, description: "Text to type; may be empty or unusual." } },
  ),
  tool("select", "Choose an option of a combobox or listbox by its ref and the option's visible label.", {
    ref,
    value: { ...value, description: "Label of the option, exactly as listed in options=[…]." },
  }),
  tool("check", "Check a checkbox, radio button or switch by its ref.", { ref }),
  tool("uncheck", "Uncheck a checkbox or switch by its ref.", { ref }),
  tool("press", "Press a key on the focused element, e.g. Enter to submit or Escape to close a dialog.", {
    key: { type: "string", enum: KEYS },
  }),
  tool("scroll", "Scroll the page vertically; positive deltaY scrolls down.", {
    deltaY: { type: "integer", minimum: -5000, maximum: 5000, description: "Pixels to scroll." },
  }),
  tool("back", "Go back one page in the browser history."),
  tool("navigate", "Open a URL on the site under test. A path such as /settings is resolved against the page.", {
    url: { type: "string", minLength: 1, maxLength: 2000, description: "Absolute URL or path on the same site." },
  }),
  tool(
    "done",
    "Hand control back to the random monkey, when the obstacle is gone or nothing sensible is left to do here.",
    { note: { type: "string", maxLength: 200, description: "A short note on why." } },
    [],
  ),
];

/** The preflight probe's only tool. */
export const PING_TOOL: ToolDefinition = tool("ping", "Answer the connectivity check by calling this tool.", {
  value: { type: "string", maxLength: 100, description: "The value the user asks for." },
});

const ajv = new Ajv({ allErrors: false, strict: true });
const validators = new Map<string, ValidateFunction>(
  [...ACTION_TOOLS, PING_TOOL].map((definition) => [definition.name, ajv.compile(definition.inputSchema)]),
);

/**
 * Turns a tool call into a decision. Never trusts the model: the input must match the tool's schema and element
 * tools must name a ref of the current snapshot. Throws `LlmError` of kind `invalid` otherwise.
 */
export function parseToolCall(name: string, input: unknown, refs: ReadonlySet<string>): Decision {
  const validate = validators.get(name);
  if (validate === undefined || name === PING_TOOL.name) throw new LlmError("invalid", `unknown tool ${quote(name)}`);
  if (!validate(input)) {
    const error = validate.errors?.[0];
    const where = error?.instancePath === "" || error === undefined ? "input" : error.instancePath.slice(1);
    throw new LlmError("invalid", `tool ${name}: ${where} ${error?.message ?? "is invalid"}`);
  }
  const args = input as Record<string, unknown>;
  if (typeof args.ref === "string" && !refs.has(args.ref)) {
    throw new LlmError("invalid", `tool ${name}: ref ${quote(args.ref)} is not in the current snapshot`);
  }
  switch (name) {
    case "click":
    case "check":
    case "uncheck":
      return { type: name, ref: args.ref as string };
    case "fill":
    case "select":
      return { type: name, ref: args.ref as string, value: args.value as string };
    case "press":
      return { type: "press", key: args.key as string };
    case "scroll":
      return { type: "scroll", deltaY: args.deltaY as number };
    case "back":
      return { type: "back" };
    case "navigate":
      return { type: "navigate", url: args.url as string };
    default:
      return { type: "done" };
  }
}

/** True when the input of a `ping` call is well-formed. */
export function isValidPing(input: unknown): boolean {
  return (validators.get(PING_TOOL.name) as ValidateFunction)(input);
}

function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}
