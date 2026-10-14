import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src", import.meta.url));
const llmDir = `llm${sep}`;

/** Static, type-only, side-effect, re-export and dynamic imports of an LLM SDK or one of its subpaths. */
const SDK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](?:openai|@anthropic-ai\/[^"']+)(?:\/[^"']*)?["']/;

/** `file:line` of every SDK import in the TypeScript files under src/, relative to src/. */
function sdkImports(): string[] {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".ts"));
  return files.flatMap((file) =>
    readFileSync(join(src, file), "utf8")
      .split("\n")
      .flatMap((line, index) => (SDK_IMPORT.test(line) ? [`${file}:${index + 1}`] : [])),
  );
}

describe("LLM SDK imports", () => {
  it("recognises SDK specifiers, subpaths included, and nothing else", () => {
    const flagged = [
      'import OpenAI from "openai";',
      'import x from "openai/client";',
      'import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";',
      'import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";',
      'export { default } from "openai";',
      'const sdk = await import("@anthropic-ai/sdk");',
    ];
    const ignored = [
      'import x from "openai-compatible";',
      'import { y } from "./openai.ts";',
      'const name = "openai";',
    ];
    assert.deepEqual(
      flagged.filter((line) => !SDK_IMPORT.test(line)),
      [],
    );
    assert.deepEqual(
      ignored.filter((line) => SDK_IMPORT.test(line)),
      [],
    );
  });

  it("happen only in src/llm/", () => {
    const imports = sdkImports();
    assert.ok(
      imports.some((where) => where.startsWith(llmDir)),
      "expected the backends in src/llm/ to import an SDK",
    );
    assert.deepEqual(
      imports.filter((where) => !where.startsWith(llmDir)),
      [],
    );
  });
});
