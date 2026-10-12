import type { LlmConfig } from "../config/config.ts";
import { AnthropicFoundryProvider } from "./anthropic-foundry.ts";
import type { LlmProvider } from "./provider.ts";

/** The provider is configured but not available in this version. Maps to exit code 2. */
export class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(`llm.provider "${provider}" is not available yet; use "anthropic-foundry"`);
    this.name = "UnsupportedProviderError";
  }
}

/** Creates the provider named by `llm.provider`. */
export function createProvider(llm: LlmConfig, log: (line: string) => void): LlmProvider {
  switch (llm.provider) {
    case "anthropic-foundry":
      return new AnthropicFoundryProvider(llm, { log });
    default:
      throw new UnsupportedProviderError(llm.provider);
  }
}
