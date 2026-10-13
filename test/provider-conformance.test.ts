import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LlmConfig, parseConfig } from "../src/config/config.ts";
import { AnthropicFoundryProvider } from "../src/llm/anthropic-foundry.ts";
import { OpenAiProvider } from "../src/llm/openai.ts";
import type { DecideInput, LlmError, LlmProvider } from "../src/llm/provider.ts";
import { connectionError, json, mockFetch } from "./helpers/http.ts";

const KEY = "sk-conformance-0123456789abcdef";

/** How one backend speaks HTTP: enough to script the same conversations against every backend. */
interface Backend {
  name: string;
  llm: Record<string, unknown>;
  create(llm: LlmConfig, fetch: typeof globalThis.fetch): LlmProvider;
  /** A successful answer calling one tool; the usage is 1000 input, 30 output, 600 cached tokens. */
  toolCall(name: string, args: unknown): Response;
  textOnly(text: string): Response;
  error(status: number, message: string): Response;
}

const BACKENDS: Backend[] = [
  {
    name: "anthropic-foundry",
    llm: { provider: "anthropic-foundry", baseUrl: "https://res.services.ai.azure.com/anthropic" },
    create: (llm, fetch) => new AnthropicFoundryProvider(llm, { fetch }),
    toolCall: (name, args) => anthropicMessage([{ type: "tool_use", id: "toolu_1", name, input: args }], "tool_use"),
    textOnly: (text) => anthropicMessage([{ type: "text", text }], "end_turn"),
    error: (status, message) => json(status, { type: "error", error: { type: "api_error", message } }),
  },
  {
    name: "openai (responses)",
    llm: { provider: "openai", baseUrl: "https://res.openai.azure.com/openai/v1" },
    create: (llm, fetch) => new OpenAiProvider(llm, { fetch }),
    toolCall: (name, args) =>
      openAiResponse([
        { type: "function_call", id: "fc", call_id: "c", name, arguments: JSON.stringify(args), status: "completed" },
      ]),
    textOnly: (text) =>
      openAiResponse([
        {
          type: "message",
          id: "m",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ]),
    error: (status, message) => json(status, { error: { message, type: "error", code: null } }),
  },
  {
    name: "openai (chat)",
    llm: { provider: "openai", baseUrl: "https://res.openai.azure.com/openai/v1", options: { api: "chat" } },
    create: (llm, fetch) => new OpenAiProvider(llm, { fetch }),
    toolCall: (name, args) =>
      chatCompletion(
        { tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        "tool_calls",
      ),
    textOnly: (text) => chatCompletion({ content: text }, "stop"),
    error: (status, message) => json(status, { error: { message, type: "error", code: null } }),
  },
];

function anthropicMessage(content: unknown[], stopReason: string): Response {
  return json(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "deployment",
    content,
    stop_reason: stopReason,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 30, cache_read_input_tokens: 600 },
  });
}

function openAiResponse(output: unknown[]): Response {
  return json(200, {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "deployment",
    status: "completed",
    incomplete_details: null,
    output,
    usage: { input_tokens: 1000, output_tokens: 30, total_tokens: 1030, input_tokens_details: { cached_tokens: 600 } },
  });
}

function chatCompletion(message: Record<string, unknown>, finishReason: string): Response {
  return json(200, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "deployment",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: null, ...message } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 30,
      total_tokens: 1030,
      prompt_tokens_details: { cached_tokens: 600 },
    },
  });
}

const input: DecideInput = {
  snapshot: 'URL: https://test.example.org/\n\nElements (1 of 1):\ne3 link "Contact form" -> /form',
  refs: new Set(["e3"]),
  history: [],
  findingsSoFar: [],
  goal: "a dialog is open",
  testDataKeys: ["email"],
  placeholders: ["{{testData.email}}"],
  role: "anonymous",
};

for (const backend of BACKENDS) {
  describe(`provider conformance: ${backend.name}`, () => {
    const setup = (llm: Record<string, unknown> = {}) => {
      const { config } = parseConfig(
        JSON.stringify({
          baseUrl: "https://test.example.org",
          llm: { deployment: "deployment", apiKey: "${API_KEY}", maxRetries: 2, ...backend.llm, ...llm },
        }),
        { env: { API_KEY: KEY } },
      );
      return config.llm as LlmConfig;
    };
    const provider = (llm: LlmConfig, ...answers: Parameters<typeof mockFetch>) => {
      const mock = mockFetch(...answers);
      return { provider: backend.create(llm, mock.fetch), requests: mock.requests };
    };

    it("turns a tool call into a validated decision and maps the usage", async () => {
      const { provider: p, requests } = provider(
        setup(),
        backend.toolCall("fill", { ref: "e3", value: "{{testData.email}}" }),
      );
      const result = await p.decide(input);
      assert.deepEqual(result.decision, { type: "fill", ref: "e3", value: "{{testData.email}}" });
      assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 30, cachedTokens: 600 });
      assert.equal(result.retries, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.body.model, "deployment");
      assert.ok(!JSON.stringify(requests[0]?.body).includes(KEY));
    });

    it("rejects calls outside the schema or the snapshot, keeping the usage", async () => {
      for (const [name, args] of [
        ["click", { ref: "e99" }],
        ["click", { ref: "e3", extra: 1 }],
        ["teleport", {}],
      ] as const) {
        const { provider: p } = provider(setup(), backend.toolCall(name, args));
        await assert.rejects(p.decide(input), (error: LlmError) => {
          assert.equal(error.kind, "invalid", error.message);
          assert.equal(error.usage?.inputTokens, 1000);
          return true;
        });
      }
    });

    it("treats a text-only answer as invalid", async () => {
      const { provider: p } = provider(setup(), backend.textOnly("I would click the link."));
      await assert.rejects(p.decide(input), (error: LlmError) => error.kind === "invalid");
    });

    it("retries 429 and 5xx, and counts the retries", async () => {
      const { provider: p, requests } = provider(
        setup(),
        backend.error(429, "slow down"),
        backend.error(500, "oops"),
        backend.toolCall("back", {}),
      );
      const result = await p.decide(input);
      assert.deepEqual(result.decision, { type: "back" });
      assert.equal(result.retries, 2);
      assert.equal(requests.length, 3);
    });

    it("does not retry other 4xx and keeps the key out of the message", async () => {
      for (const [status, kind] of [
        [400, "badRequest"],
        [401, "auth"],
        [403, "forbidden"],
        [404, "notFound"],
      ] as const) {
        const { provider: p, requests } = provider(setup(), backend.error(status, `rejected ${KEY}`));
        await assert.rejects(p.decide(input), (error: LlmError) => {
          assert.equal(error.kind, kind);
          assert.equal(error.status, status);
          assert.ok(!error.message.includes(KEY), error.message);
          return true;
        });
        assert.equal(requests.length, 1);
      }
    });

    it("maps connection failures", async () => {
      const { provider: p } = provider(setup({ maxRetries: 0 }), connectionError("ECONNREFUSED"));
      await assert.rejects(p.decide(input), (error: LlmError) => {
        assert.equal(error.kind, "unreachable");
        assert.match(error.message, /ECONNREFUSED/);
        return true;
      });
    });

    it("passes the preflight only with a ping tool call", async () => {
      const ok = provider(setup(), backend.toolCall("ping", { value: "x" }));
      const passed = await ok.provider.preflight();
      assert.equal(passed.ok, true);
      const tools = JSON.stringify(ok.requests[0]?.body.tools);
      assert.match(tools, /"ping"/);
      assert.doesNotMatch(tools, /"click"/);

      for (const answer of [backend.textOnly("pong"), backend.toolCall("click", { ref: "e3" })]) {
        const bad = provider(setup(), answer);
        const failed = await bad.provider.preflight();
        assert.equal(failed.ok, false);
        if (!failed.ok) assert.equal(failed.error.kind, "invalid");
      }
    });
  });
}
