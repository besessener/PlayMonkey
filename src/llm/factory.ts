import type { LlmConfig } from "../config/config.ts";
import { AnthropicFoundryProvider } from "./anthropic-foundry.ts";
import { OpenAiProvider } from "./openai.ts";
import type { LlmProvider } from "./provider.ts";

/** Creates the provider named by `llm.provider`. */
export function createProvider(llm: LlmConfig, log: (line: string) => void): LlmProvider {
  switch (llm.provider) {
    case "anthropic-foundry":
      return new AnthropicFoundryProvider(llm, { log });
    case "openai":
      return new OpenAiProvider(llm, { log });
  }
}
