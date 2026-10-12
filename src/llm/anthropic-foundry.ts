import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { LlmConfig } from "../config/config.ts";
import { buildUserMessage, pingMessage, SYSTEM_PROMPT } from "./prompt.ts";
import {
  type DecideInput,
  type DecideResult,
  type Decision,
  LlmError,
  type LlmErrorKind,
  type LlmProvider,
  type LlmUsage,
  type PreflightResult,
} from "./provider.ts";
import { mapSdkError } from "./sdk-errors.ts";
import { ACTION_TOOLS, isValidPing, PING_TOOL, parseToolCall, type ToolDefinition } from "./tools.ts";

export interface FoundryOptions {
  /** Replaces the HTTP layer; tests use it to mock responses. */
  fetch?: typeof fetch;
  /** Receives notices such as a stripped `/v1`. */
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * `LlmProvider` for Claude on Microsoft Foundry, through the official Anthropic SDK's Foundry client. The model is
 * the deployment name. The SDK retries rate limits, server and connection errors with backoff (`llm.maxRetries`);
 * other errors fail at once.
 */
export class AnthropicFoundryProvider implements LlmProvider {
  readonly name = "anthropic-foundry";
  readonly baseUrl: string;
  readonly #config: LlmConfig;
  readonly #client: AnthropicFoundry;
  readonly #tools: Tool[];
  readonly #now: () => number;
  /** HTTP requests sent since the last reset; more than one per call means retries. */
  #requests = 0;

  constructor(config: LlmConfig, options: FoundryOptions = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
    const { url, stripped } = normalizeFoundryBaseUrl(config.baseUrl);
    this.baseUrl = url;
    if (stripped !== undefined) {
      options.log?.(`llm: removed "${stripped}" from llm.baseUrl; the SDK appends /v1/messages itself`);
    }
    const send = options.fetch ?? fetch;
    this.#client = new AnthropicFoundry({
      apiKey: config.apiKey,
      baseURL: url,
      // Explicit, so ANTHROPIC_FOUNDRY_RESOURCE in the environment cannot change the endpoint.
      resource: null as unknown as undefined,
      maxRetries: config.maxRetries,
      timeout: config.timeoutMs,
      logLevel: "off",
      fetch: (async (...args: Parameters<typeof fetch>) => {
        this.#requests++;
        return send(...args);
      }) as typeof fetch,
    });
    this.#tools = ACTION_TOOLS.map(toAnthropicTool);
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const message = await this.#send({
      ...this.#base(),
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: this.#tools,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });
    const usage = mapUsage(message);
    const retries = this.#retries();
    const fail = (kind: LlmErrorKind, reason: string): never => {
      throw new LlmError(kind, reason, { usage, retries, raw: message });
    };
    const call = this.#toolCall(message, fail);
    let decision: Decision;
    try {
      decision = parseToolCall(call.name, call.input, input.refs);
    } catch (error) {
      if (error instanceof LlmError) fail(error.kind, error.message);
      throw error;
    }
    return { decision, usage, retries, raw: message };
  }

  async preflight(): Promise<PreflightResult> {
    const started = this.#now();
    const value = `monkey-${started % 100_000}`;
    try {
      const message = await this.#send({
        ...this.#base(),
        tools: [toAnthropicTool(PING_TOOL)],
        messages: [{ role: "user", content: pingMessage(value) }],
      });
      const usage = mapUsage(message);
      const call = this.#toolCall(message, (kind, reason) => {
        throw new LlmError(kind, reason, { usage });
      });
      if (call.name !== PING_TOOL.name || !isValidPing(call.input)) {
        throw new LlmError("invalid", `the model called ${JSON.stringify(call.name)} with unexpected input`, { usage });
      }
      return { ok: true, latencyMs: this.#now() - started, usage };
    } catch (error) {
      return { ok: false, error: error instanceof LlmError ? error : this.#mapError(error) };
    }
  }

  #base(): Omit<MessageCreateParamsNonStreaming, "messages"> {
    const { options } = this.#config;
    return {
      model: this.#config.deployment,
      max_tokens: options.maxOutputTokens,
      // `any` and `tool` are rejected by some models; the prompt asks for exactly one tool call instead.
      tool_choice: { type: "auto" },
      ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking } }),
      ...(options.effort === undefined ? {} : { output_config: { effort: options.effort } }),
    };
  }

  async #send(params: MessageCreateParamsNonStreaming): Promise<Message> {
    this.#requests = 0;
    try {
      return await this.#client.messages.create(params);
    } catch (error) {
      throw this.#mapError(error);
    }
  }

  /** The first tool call of a response, or a failure for refusals, truncation and text-only answers. */
  #toolCall(message: Message, fail: (kind: LlmErrorKind, reason: string) => never): ToolUseBlock {
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      return fail("refusal", `the model refused${category ? ` (${category})` : ""}`);
    }
    const call = message.content.find((block): block is ToolUseBlock => block.type === "tool_use");
    if (message.stop_reason === "max_tokens") {
      return fail(
        "maxTokens",
        "the response hit max_tokens before a complete tool call; raise llm.options.maxOutputTokens",
      );
    }
    if (call === undefined) return fail("invalid", "the response contained text only, no tool call");
    return call;
  }

  #retries(): number {
    return Math.max(0, this.#requests - 1);
  }

  /** Maps the SDK's typed errors, most specific first. Messages never include the key. */
  #mapError(error: unknown): LlmError {
    return mapSdkError(AnthropicFoundry, error, {
      apiKey: this.#config.apiKey,
      timeoutMs: this.#config.timeoutMs,
      retries: this.#retries(),
    });
  }
}

/**
 * The SDK expects the URL up to `/anthropic` and appends `/v1/messages`. A URL copied from the portal often ends in
 * `/v1` or `/v1/messages`; that part is removed and returned as `stripped`.
 */
export function normalizeFoundryBaseUrl(baseUrl: string): { url: string; stripped?: string } {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  const match = /\/v1(\/messages)?\/*$/.exec(url.pathname);
  if (match === null) return { url: url.href.replace(/\/+$/, "") };
  url.pathname = url.pathname.slice(0, match.index);
  return { url: url.href.replace(/\/+$/, ""), stripped: match[0].replace(/\/+$/, "") };
}

function toAnthropicTool(definition: ToolDefinition): Tool {
  return { name: definition.name, description: definition.description, input_schema: definition.inputSchema };
}

function mapUsage(message: Message): LlmUsage {
  const { usage } = message;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens == null ? {} : { cachedTokens: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens == null ? {} : { cacheWriteTokens: usage.cache_creation_input_tokens }),
  };
}
