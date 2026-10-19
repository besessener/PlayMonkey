import { Ajv } from "ajv";
import { firstLine } from "./prompt.ts";
import { type InspectInput, LlmError, VISUAL_KINDS, type VisualBug, type VisualKind } from "./provider.ts";
import type { ToolDefinition } from "./tools.ts";

/** The most bugs one screenshot may report; more would only be noise. */
const MAX_BUGS = 5;

export const VISUAL_SYSTEM_PROMPT = `You review screenshots of a website running in a test environment for visual bugs a user would notice:
- overlap: text or controls covering each other;
- cut-off: text or controls clipped by their container or the viewport edge without an ellipsis;
- unreadable: text that cannot be read, e.g. too little contrast or too small;
- broken-image: an image that failed to load;
- misplaced: an element clearly out of place, e.g. a footer in the middle of the content.

Ignore deliberate design (decorative overlays, intentional truncation with an ellipsis), content choices and anything
you are not sure about. Black boxes hide secret values on purpose; they are not bugs.

Respond with exactly one call of report_visual_bugs and no other text; an empty list when nothing is clearly wrong.`;

export const VISUAL_TOOL: ToolDefinition = {
  name: "report_visual_bugs",
  description: "Report the visual bugs in the screenshot; an empty list when there are none.",
  inputSchema: {
    type: "object",
    properties: {
      bugs: {
        type: "array",
        maxItems: MAX_BUGS,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: VISUAL_KINDS },
            description: {
              type: "string",
              minLength: 1,
              maxLength: 300,
              description: "What is wrong and where, in one sentence.",
            },
          },
          required: ["kind", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["bugs"],
    additionalProperties: false,
  },
};

const validate = new Ajv({ allErrors: false, strict: true }).compile(VISUAL_TOOL.inputSchema);

/** The user message of a visual check; the screenshot goes next to it. */
export function visualMessage(input: InspectInput): string {
  const { width, height } = input.viewport;
  return `Page: ${input.page}\nViewport: ${width}x${height}\nThe screenshot shows the visible part of the page. Report its visual bugs.`;
}

/** Turns a `report_visual_bugs` call into bugs. Never trusts the model: throws `LlmError` `invalid` otherwise. */
export function parseVisualReport(name: string, input: unknown): VisualBug[] {
  if (name !== VISUAL_TOOL.name) throw new LlmError("invalid", `unknown tool ${JSON.stringify(name.slice(0, 40))}`);
  if (validate(input) !== true) {
    const error = validate.errors?.[0];
    const where = error?.instancePath === "" || error === undefined ? "input" : error.instancePath.slice(1);
    throw new LlmError("invalid", `tool ${name}: ${where} ${error?.message ?? "is invalid"}`);
  }
  const { bugs } = input as { bugs: { kind: VisualKind; description: string }[] };
  return bugs.map(({ kind, description }) => ({ kind, description: firstLine(description) }));
}
