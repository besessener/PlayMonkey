import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { maskSecrets, type Secrets } from "../config/secrets.ts";
import { buildUserMessage } from "./prompt.ts";
import type { DecideInput } from "./provider.ts";

export interface DebugEntry {
  role: string;
  step: number;
  attempt: number;
  input: DecideInput;
  result?: unknown;
  error?: string;
  raw?: unknown;
}

/**
 * `llm-debug.jsonl`: one line per LLM call with the prompt and the response, written only with `llm.debugLog`. The
 * prompt holds placeholders instead of secrets already; every string is masked once more before writing.
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
    const { refs: _, ...input } = entry.input;
    const line = maskSecrets(
      {
        time: new Date().toISOString(),
        role: entry.role,
        step: entry.step,
        attempt: entry.attempt,
        prompt: buildUserMessage(entry.input),
        input,
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.raw === undefined ? {} : { response: entry.raw }),
      },
      this.#secrets,
    );
    await appendFile(this.file, `${JSON.stringify(line)}\n`);
  }
}
