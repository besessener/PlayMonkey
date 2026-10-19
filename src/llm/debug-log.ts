import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { maskSecrets, type Secrets } from "../config/secrets.ts";
import { buildUserMessage } from "./prompt.ts";
import type { DecideInput, InspectInput, Screenshot } from "./provider.ts";
import { visualMessage } from "./visual.ts";

export interface DebugEntry {
  role: string;
  step: number;
  attempt: number;
  /** An action decision, or a visual check. */
  input: DecideInput | InspectInput;
  result?: unknown;
  error?: string;
  raw?: unknown;
}

/**
 * `llm-debug.jsonl`: one line per LLM call with the prompt and the response, written only with `llm.debugLog`. The
 * prompt holds placeholders instead of secrets already; every string is masked once more before writing. Screenshots
 * are described, not written.
 */
export class DebugLog {
  readonly file: string;
  readonly #secrets: Secrets;
  #ready: Promise<unknown> | undefined;

  constructor(file: string, secrets: Secrets) {
    this.file = file;
    this.#secrets = secrets;
  }

  async write(entry: DebugEntry): Promise<void> {
    this.#ready ??= mkdir(dirname(this.file), { recursive: true });
    await this.#ready;
    const line = maskSecrets(
      {
        time: new Date().toISOString(),
        role: entry.role,
        step: entry.step,
        attempt: entry.attempt,
        ...describeInput(entry.input),
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.raw === undefined ? {} : { response: entry.raw }),
      },
      this.#secrets,
    );
    await appendFile(this.file, `${JSON.stringify(line)}\n`);
  }
}

/** The prompt and the input, with the screenshot's size instead of its data. */
function describeInput(input: DecideInput | InspectInput): { prompt: string; input: Record<string, unknown> } {
  if ("snapshot" in input) {
    const { refs: _, screenshot, ...rest } = input;
    return { prompt: buildUserMessage(input), input: { ...rest, ...describeScreenshot(screenshot) } };
  }
  const { screenshot, ...rest } = input;
  return { prompt: visualMessage(input), input: { ...rest, ...describeScreenshot(screenshot) } };
}

function describeScreenshot(screenshot: Screenshot | undefined): { screenshot?: string } {
  if (screenshot === undefined) return {};
  const bytes = Math.floor((screenshot.data.length * 3) / 4);
  return { screenshot: `${screenshot.mediaType}, about ${bytes} bytes (not logged)` };
}
