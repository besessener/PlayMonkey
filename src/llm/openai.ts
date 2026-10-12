import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionFunctionTool,
} from "openai/resources/chat/completions";
import type {
  FunctionTool,
  Response as OpenAiResponse,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import type { LlmConfig } from "../config/config.ts";
import type { OpenAiApi } from "../config/schema.ts";
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

export interface OpenAiOptions {
  /** Replaces the HTTP layer; tests use it to mock responses. */
  fetch?: typeof fetch;
  /** Receives notices such as a removed `/responses` suffix. */
  log?: (line: string) => void;
  now?: () => number;
}

/** A tool call as both API surfaces return it: a name and its arguments as a JSON string. */
interface RawToolCall {
  name: string;
  arguments: string;
}

/** What a response amounts to, independent of the API surface. */
interface Answer {
  usage: LlmUsage;
  call?: RawToolCall;
  /** Set when the answer is unusable: cut off, filtered or refused. */
  problem?: { kind: LlmErrorKind; reason: string };
  raw: unknown;
}

/**
 * `LlmProvider` for OpenAI-compatible endpoints, such as OpenAI models on Microsoft Foundry
 * (`https://<resource>.openai.azure.com/openai/v1`), through the official `openai` SDK. The base URL is taken as
 * configured; the model is the deployment name. `llm.options.api` selects the Responses API (default, recommended
 * for new applications) or Chat Completions (for models that only offer that surface). The SDK retries rate
 * limits, server and connection errors with backoff (`llm.maxRetries`); other errors fail at once.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly baseUrl: string;
  readonly api: OpenAiApi;
  readonly #config: LlmConfig;
  readonly #client: OpenAI;
  readonly #now: () => number;
  /** HTTP requests sent since the last reset; more than one per call means retries. */
  #requests = 0;

  constructor(config: LlmConfig, options: OpenAiOptions = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
    this.api = config.options.api ?? "responses";
    const { url, stripped } = normalizeOpenAiBaseUrl(config.baseUrl);
    this.baseUrl = url;
    if (stripped !== undefined) {
      options.log?.(`llm: removed "${stripped}" from llm.baseUrl; the SDK appends the API path itself`);
    }
    const send = options.fetch ?? fetch;
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: url,
      // Explicit, so OPENAI_ORG_ID, OPENAI_PROJECT_ID and friends in the environment cannot change the requests.
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      maxRetries: config.maxRetries,
      timeout: config.timeoutMs,
      logLevel: "off",
      fetch: (async (...args: Parameters<typeof fetch>) => {
        this.#requests++;
        return send(...args);
      }) as typeof fetch,
    });
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const answer = await this.#ask(ACTION_TOOLS, SYSTEM_PROMPT, buildUserMessage(input));
    const retries = this.#retries();
    const fail = (kind: LlmErrorKind, reason: string): never => {
      throw new LlmError(kind, reason, { usage: answer.usage, retries, raw: answer.raw });
    };
    const call = toolCall(answer, fail);
    let decision: Decision;
    try {
      decision = parseToolCall(call.name, parseArguments(call, fail), input.refs);
    } catch (error) {
      if (error instanceof LlmError) fail(error.kind, error.message);
      throw error;
    }
    return { decision, usage: answer.usage, retries, raw: answer.raw };
  }

  async preflight(): Promise<PreflightResult> {
    const started = this.#now();
    const value = `monkey-${started % 100_000}`;
    try {
      const answer = await this.#ask([PING_TOOL], undefined, pingMessage(value));
      const fail = (kind: LlmErrorKind, reason: string): never => {
        throw new LlmError(kind, reason, { usage: answer.usage });
      };
      const call = toolCall(answer, fail);
      if (call.name !== PING_TOOL.name || !isValidPing(parseArguments(call, fail))) {
        fail("invalid", `the model called ${JSON.stringify(call.name)} with unexpected input`);
      }
      return { ok: true, latencyMs: this.#now() - started, usage: answer.usage };
    } catch (error) {
      return { ok: false, error: error instanceof LlmError ? error : this.#mapError(error) };
    }
  }

  /** One request on the configured API surface; the system prompt and tools come first for prompt caching. */
  async #ask(tools: readonly ToolDefinition[], system: string | undefined, user: string): Promise<Answer> {
    const { options } = this.#config;
    this.#requests = 0;
    try {
      if (this.api === "chat") {
        const params: ChatCompletionCreateParamsNonStreaming = {
          model: this.#config.deployment,
          messages: [
            ...(system === undefined ? [] : [{ role: "system" as const, content: system }]),
            { role: "user", content: user },
          ],
          tools: tools.map(toChatTool),
          // A forced tool choice is rejected by some models; the prompt asks for exactly one tool call instead.
          tool_choice: "auto",
          max_completion_tokens: options.maxOutputTokens,
          ...(options.effort === undefined ? {} : { reasoning_effort: options.effort }),
        };
        return fromChat(await this.#client.chat.completions.create(params));
      }
      const params: ResponseCreateParamsNonStreaming = {
        model: this.#config.deployment,
        ...(system === undefined ? {} : { instructions: system }),
        input: [{ role: "user", content: user }],
        tools: tools.map(toResponsesTool),
        tool_choice: "auto",
        max_output_tokens: options.maxOutputTokens,
        // Prompts contain page content of the site under test: do not keep them on the server.
        store: false,
        ...(options.effort === undefined ? {} : { reasoning: { effort: options.effort } }),
      };
      return fromResponses(await this.#client.responses.create(params));
    } catch (error) {
      throw this.#mapError(error);
    }
  }

  #retries(): number {
    return Math.max(0, this.#requests - 1);
  }

  #mapError(error: unknown): LlmError {
    return mapSdkError(OpenAI, error, {
      apiKey: this.#config.apiKey,
      timeoutMs: this.#config.timeoutMs,
      retries: this.#retries(),
    });
  }
}

/**
 * The SDK appends `/responses` or `/chat/completions` to the base URL. A URL copied with one of them (or with an
 * `api-version` query, which the v1 API does not need) is shortened; the removed path is returned as `stripped`.
 */
export function normalizeOpenAiBaseUrl(baseUrl: string): { url: string; stripped?: string } {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  const match = /\/(responses|chat\/completions)\/*$/.exec(url.pathname);
  if (match === null) return { url: url.href.replace(/\/+$/, "") };
  url.pathname = url.pathname.slice(0, match.index);
  return { url: url.href.replace(/\/+$/, ""), stripped: match[0].replace(/\/+$/, "") };
}

/**
 * Strict mode is off on purpose: it demands that every property is required and restricts the schema keywords,
 * which some deployments reject. Every call is validated against the full schema by `parseToolCall` instead.
 */
function toResponsesTool(definition: ToolDefinition): FunctionTool {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as unknown as Record<string, unknown>,
    strict: false,
  };
}

function toChatTool(definition: ToolDefinition): ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema as unknown as Record<string, unknown>,
      strict: false,
    },
  };
}

function fromResponses(response: OpenAiResponse): Answer {
  const details = response.usage?.input_tokens_details;
  const usage: LlmUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    ...(details?.cached_tokens == null ? {} : { cachedTokens: details.cached_tokens }),
    ...(details?.cache_write_tokens == null ? {} : { cacheWriteTokens: details.cache_write_tokens }),
  };
  const answer: Answer = { usage, raw: response };
  const call = response.output.find((item): item is ResponseFunctionToolCall => item.type === "function_call");
  if (call !== undefined) answer.call = { name: call.name, arguments: call.arguments };
  const refusal = response.output.flatMap((item) =>
    item.type === "message" ? item.content.filter((part) => part.type === "refusal") : [],
  )[0];
  const reason = response.incomplete_details?.reason;
  if (refusal !== undefined)
    answer.problem = { kind: "refusal", reason: `the model refused: ${firstLine(refusal.refusal)}` };
  else if (reason === "content_filter")
    answer.problem = { kind: "refusal", reason: "the response was filtered (content_filter)" };
  else if (response.status === "incomplete" && call === undefined) {
    answer.problem =
      reason === "max_output_tokens"
        ? truncated()
        : { kind: "invalid", reason: `the response is incomplete (${reason ?? "unknown reason"})` };
  } else if (response.status === "failed") {
    answer.problem = {
      kind: "server",
      reason: `the response failed: ${firstLine(response.error?.message ?? "unknown error")}`,
    };
  }
  return answer;
}

function fromChat(completion: ChatCompletion): Answer {
  const details = completion.usage?.prompt_tokens_details;
  const usage: LlmUsage = {
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
    ...(details?.cached_tokens == null ? {} : { cachedTokens: details.cached_tokens }),
    ...(details?.cache_write_tokens == null ? {} : { cacheWriteTokens: details.cache_write_tokens }),
  };
  const answer: Answer = { usage, raw: completion };
  const choice = completion.choices[0];
  const call = choice?.message.tool_calls?.find((item) => item.type === "function");
  if (call !== undefined && call.type === "function") {
    answer.call = { name: call.function.name, arguments: call.function.arguments };
  }
  if (choice?.message.refusal != null) {
    answer.problem = { kind: "refusal", reason: `the model refused: ${firstLine(choice.message.refusal)}` };
  } else if (choice?.finish_reason === "content_filter") {
    answer.problem = { kind: "refusal", reason: "the response was filtered (content_filter)" };
  } else if (choice?.finish_reason === "length") {
    answer.problem = truncated();
  }
  return answer;
}

function truncated(): { kind: LlmErrorKind; reason: string } {
  return {
    kind: "maxTokens",
    reason: "the response hit the output token limit before a complete tool call; raise llm.options.maxOutputTokens",
  };
}

/** The first tool call, or a failure for refusals, truncation and text-only answers. */
function toolCall(answer: Answer, fail: (kind: LlmErrorKind, reason: string) => never): RawToolCall {
  if (answer.problem !== undefined) return fail(answer.problem.kind, answer.problem.reason);
  if (answer.call === undefined) return fail("invalid", "the response contained text only, no tool call");
  return answer.call;
}

/** Tool arguments arrive as a JSON string; anything that does not parse is an invalid answer. */
function parseArguments(call: RawToolCall, fail: (kind: LlmErrorKind, reason: string) => never): unknown {
  try {
    return JSON.parse(call.arguments === "" ? "{}" : call.arguments);
  } catch {
    return fail("invalid", `tool ${JSON.stringify(call.name)}: arguments are not valid JSON`);
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
