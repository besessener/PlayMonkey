import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LlmConfig, parseConfig } from "../src/config/config.ts";
import { normalizeOpenAiBaseUrl, OpenAiProvider } from "../src/llm/openai.ts";
import { runPreflight } from "../src/llm/preflight.ts";
import type { DecideInput, LlmError, LlmErrorKind } from "../src/llm/provider.ts";
import { serializeSnapshot } from "../src/snapshot/serialize.ts";
import type { Snapshot } from "../src/snapshot/snapshot.ts";
import { type CapturedRequest, json, mockFetch } from "./helpers/http.ts";

const KEY = "sk-openai-0123456789abcdef";

function llmConfig(llm: Record<string, unknown> = {}) {
  const { config, secrets } = parseConfig(
    JSON.stringify({
      baseUrl: "https://test.example.org",
      llm: {
        provider: "openai",
        baseUrl: "https://res.openai.azure.com/openai/v1/",
        deployment: "my-gpt-deployment",
        apiKey: "${FOUNDRY_API_KEY}",
        maxRetries: 2,
        ...llm,
      },
    }),
    { env: { FOUNDRY_API_KEY: KEY } },
  );
  return { llm: config.llm as LlmConfig, secrets };
}

const USAGE = {
  input_tokens: 1500,
  output_tokens: 40,
  total_tokens: 1540,
  input_tokens_details: { cached_tokens: 1024 },
};

/** A Responses API answer with the given output items. */
function response(output: unknown[], extra: Record<string, unknown> = {}) {
  return json(200, {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "my-gpt-deployment",
    status: "completed",
    incomplete_details: null,
    output,
    usage: USAGE,
    ...extra,
  });
}

const functionCall = (name: string, args: unknown) => ({
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
  status: "completed",
});

const textMessage = (text: string) => ({
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

/** A Chat Completions answer. */
function completion(message: Record<string, unknown>, finishReason = "tool_calls") {
  return json(200, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "my-gpt-deployment",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: null, ...message } }],
    usage: {
      prompt_tokens: 900,
      completion_tokens: 25,
      total_tokens: 925,
      prompt_tokens_details: { cached_tokens: 512 },
    },
  });
}

const apiError = (status: number, text: string) =>
  json(status, { error: { message: text, type: "invalid_request_error", code: null } });

const snapshot: Snapshot = {
  url: "https://test.example.org/",
  title: "Home",
  elements: [
    { ref: "e3", role: "link", name: "Contact form", url: "/form", enabled: true, inViewport: true, inFrame: false },
  ],
  text: "Welcome",
  crossOriginFrames: 0,
  dialogs: [],
  hash: "abc",
};

const input: DecideInput = {
  snapshot: serializeSnapshot(snapshot),
  refs: new Set(["e3"]),
  history: [],
  findingsSoFar: [],
  goal: "no new page or state for 25 steps",
  testDataKeys: [],
  placeholders: [],
  role: "anonymous",
};

describe("openai provider", () => {
  it("takes the base URL as configured and only removes a copied API path or query", () => {
    assert.deepEqual(normalizeOpenAiBaseUrl("https://r.openai.azure.com/openai/v1/"), {
      url: "https://r.openai.azure.com/openai/v1",
    });
    assert.deepEqual(
      normalizeOpenAiBaseUrl("https://r.services.ai.azure.com/api/projects/p/openai/v1?api-version=preview"),
      { url: "https://r.services.ai.azure.com/api/projects/p/openai/v1" },
    );
    assert.deepEqual(normalizeOpenAiBaseUrl("https://r.openai.azure.com/openai/v1/responses"), {
      url: "https://r.openai.azure.com/openai/v1",
      stripped: "/responses",
    });
    assert.deepEqual(normalizeOpenAiBaseUrl("https://r.openai.azure.com/openai/v1/chat/completions/"), {
      url: "https://r.openai.azure.com/openai/v1",
      stripped: "/chat/completions",
    });
  });

  it("uses the Responses API by default, with the deployment as model", async () => {
    const { llm } = llmConfig();
    const { fetch, requests } = mockFetch(
      response([textMessage("Opening the form."), functionCall("click", { ref: "e3" })]),
    );
    const result = await new OpenAiProvider(llm, { fetch }).decide(input);

    assert.deepEqual(result.decision, { type: "click", ref: "e3" });
    assert.deepEqual(result.usage, { inputTokens: 476, outputTokens: 40, cachedTokens: 1024 });
    assert.equal(result.retries, 0);

    const [request] = requests as [CapturedRequest];
    assert.equal(request.url, "https://res.openai.azure.com/openai/v1/responses");
    assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(request.body.model, "my-gpt-deployment");
    assert.equal(request.body.tool_choice, "auto");
    assert.equal(request.body.store, false);
    assert.equal(request.body.max_output_tokens, 4096);
    assert.equal("reasoning" in request.body, false);
    assert.match(String(request.body.instructions), /^You are an exploratory tester/);
    const tools = request.body.tools as { type: string; name: string; strict: boolean; parameters: unknown }[];
    assert.equal(tools.length, 12);
    assert.ok(tools.every((tool) => tool.type === "function" && tool.strict === false));
    assert.deepEqual(tools[0]?.parameters, {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$", description: "Ref of an element, e.g. e12." },
      },
      required: ["ref"],
      additionalProperties: false,
    });
    const [message] = request.body.input as { role: string; content: string }[];
    assert.equal(message?.role, "user");
    assert.match(message?.content ?? "", /e3 link "Contact form" -> \/form/);
    assert.ok(!JSON.stringify(request.body).includes(KEY));
  });

  it("uses Chat Completions with llm.options.api chat", async () => {
    const { llm } = llmConfig({ options: { api: "chat", effort: "low", maxOutputTokens: 300 } });
    const { fetch, requests } = mockFetch(
      completion({
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "fill", arguments: '{"ref":"e3","value":"x"}' } },
        ],
      }),
    );
    const result = await new OpenAiProvider(llm, { fetch }).decide(input);
    assert.deepEqual(result.decision, { type: "fill", ref: "e3", value: "x" });
    assert.deepEqual(result.usage, { inputTokens: 388, outputTokens: 25, cachedTokens: 512 });

    const [request] = requests as [CapturedRequest];
    assert.equal(request.url, "https://res.openai.azure.com/openai/v1/chat/completions");
    assert.equal(request.body.model, "my-gpt-deployment");
    assert.equal(request.body.max_completion_tokens, 300);
    assert.equal(request.body.reasoning_effort, "low");
    assert.equal(request.body.tool_choice, "auto");
    const messages = request.body.messages as { role: string }[];
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "user"],
    );
    const tools = request.body.tools as { type: string; function: { name: string; strict: boolean } }[];
    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      [
        "click",
        "dblclick",
        "hover",
        "fill",
        "select",
        "check",
        "uncheck",
        "press",
        "scroll",
        "back",
        "navigate",
        "done",
      ],
    );
  });

  it("works with STACKIT AI Model Serving on Chat Completions, answered the way vLLM does", async () => {
    const { llm } = llmConfig({
      baseUrl: "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1",
      deployment: "my-stackit-model",
      options: { api: "chat" },
    });
    const { fetch, requests } = mockFetch(
      json(200, {
        id: "chatcmpl-5f0c2a9e1b7d4c3a8e6f",
        object: "chat.completion",
        created: 0,
        model: "my-stackit-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              annotations: null,
              audio: null,
              function_call: null,
              reasoning_content: null,
              tool_calls: [
                {
                  id: "chatcmpl-tool-9a1e4c7b2d8f4e06",
                  type: "function",
                  function: { name: "click", arguments: '{"ref": "e3"}' },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
            stop_reason: null,
          },
        ],
        service_tier: null,
        system_fingerprint: null,
        usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230, prompt_tokens_details: null },
        prompt_logprobs: null,
        kv_transfer_params: null,
      }),
    );
    const result = await new OpenAiProvider(llm, { fetch }).decide(input);

    assert.deepEqual(result.decision, { type: "click", ref: "e3" });
    assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 30 });
    const [request] = requests as [CapturedRequest];
    assert.equal(request.url, "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(request.body.model, "my-stackit-model");
    assert.ok((request.body.tools as unknown[]).length > 0, "an empty tools list is rejected by the service");
  });

  it("sends the effort as reasoning effort on the Responses API", async () => {
    const { llm } = llmConfig({ options: { effort: "medium" } });
    const { fetch, requests } = mockFetch(response([functionCall("back", {})]));
    await new OpenAiProvider(llm, { fetch }).decide(input);
    assert.deepEqual(requests[0]?.body.reasoning, { effort: "medium" });
  });

  it("logs a notice when it removes an API path from the base URL", () => {
    const { llm } = llmConfig({ baseUrl: "https://res.openai.azure.com/openai/v1/responses" });
    const notices: string[] = [];
    const provider = new OpenAiProvider(llm, { log: (line) => notices.push(line) });
    assert.equal(provider.baseUrl, "https://res.openai.azure.com/openai/v1");
    assert.match(notices.join("\n"), /removed "\/responses" from llm\.baseUrl/);
  });

  it("treats refusals, filtered, truncated and malformed answers as failed decisions", async () => {
    const cases: [Response, LlmErrorKind, string?][] = [
      [
        response([
          {
            type: "message",
            id: "m",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "No." }],
          },
        ]),
        "refusal",
      ],
      [response([], { status: "incomplete", incomplete_details: { reason: "content_filter" } }), "refusal"],
      [response([], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), "maxTokens"],
      [response([textMessage("I would click the link.")]), "invalid"],
      [response([functionCall("click", "{not json")]), "invalid"],
      [response([functionCall("click", { ref: "e77" })]), "invalid"],
      [completion({ refusal: "I can't help with that." }, "stop"), "refusal", "chat"],
      [completion({ content: "" }, "length"), "maxTokens", "chat"],
      [completion({ content: "" }, "content_filter"), "refusal", "chat"],
      [completion({ content: "Clicking." }, "stop"), "invalid", "chat"],
    ];
    for (const [answer, kind, api] of cases) {
      const { llm } = llmConfig(api === undefined ? {} : { options: { api } });
      const { fetch } = mockFetch(answer);
      await assert.rejects(new OpenAiProvider(llm, { fetch }).decide(input), (error: LlmError) => {
        assert.equal(error.kind, kind, `${api ?? "responses"}: ${error.message}`);
        assert.ok((error.usage?.inputTokens ?? 0) > 0, "the failed call still cost tokens");
        return true;
      });
    }
  });

  it("ignores OPENAI_* variables in the environment", async () => {
    const saved = { ...process.env };
    process.env.OPENAI_BASE_URL = "https://other.example.com/v1";
    process.env.OPENAI_ORG_ID = "org-other";
    process.env.OPENAI_PROJECT_ID = "proj-other";
    try {
      const { llm } = llmConfig();
      const { fetch, requests } = mockFetch(response([functionCall("back", {})]));
      await new OpenAiProvider(llm, { fetch }).decide(input);
      assert.equal(requests[0]?.url, "https://res.openai.azure.com/openai/v1/responses");
      assert.equal(requests[0]?.headers.get("openai-organization"), null);
      assert.equal(requests[0]?.headers.get("openai-project"), null);
    } finally {
      process.env = saved;
    }
  });

  it("gives openai-specific preflight hints", async () => {
    const cases: [number, string, RegExp][] = [
      [
        404,
        "DeploymentNotFound",
        /openai\/v1; if the deployment does not offer the Responses API, set llm\.options\.api to "chat"/,
      ],
      [403, "no", /Cognitive Services OpenAI User/],
      [400, "tools are not supported", /try llm\.options\.api/],
      [401, `bad key ${KEY}`, /check llm\.apiKey/],
    ];
    for (const [status, text, hint] of cases) {
      const { llm, secrets } = llmConfig({ maxRetries: 0 });
      const { fetch } = mockFetch(apiError(status, text));
      const { result, message } = await runPreflight(new OpenAiProvider(llm, { fetch }), llm, secrets);
      assert.equal(result.ok, false);
      assert.match(
        message,
        /^llm preflight failed: openai at https:\/\/res\.openai\.azure\.com\/openai\/v1\/, deployment my-gpt-deployment, HTTP \d{3}/,
      );
      assert.match(message, hint);
      assert.ok(!message.includes(KEY), message);
    }
  });

  it("rejects options of the other backend in the config", () => {
    assert.throws(
      () => llmConfig({ options: { thinking: "disabled" } }),
      /llm\.options\.thinking: is only for anthropic-foundry/,
    );
    assert.throws(
      () => llmConfig({ provider: "anthropic-foundry", options: { api: "chat" } }),
      /llm\.options\.api: is only for the openai provider/,
    );
  });
});

// Opt-in: one real call against an OpenAI-compatible deployment.
const live = process.env.OPENAI_COMPAT_API_KEY !== undefined && process.env.OPENAI_COMPAT_BASE_URL !== undefined;
describe("openai against a real endpoint", {
  skip: live
    ? false
    : "set OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_BASE_URL (and OPENAI_COMPAT_DEPLOYMENT, OPENAI_COMPAT_API)",
}, () => {
  it("decides on the fixture snapshot", async () => {
    const { llm } = llmConfig({
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL,
      deployment: process.env.OPENAI_COMPAT_DEPLOYMENT ?? "gpt-5-mini",
      options: { api: process.env.OPENAI_COMPAT_API ?? "responses" },
    });
    const provider = new OpenAiProvider({ ...llm, apiKey: process.env.OPENAI_COMPAT_API_KEY as string });
    const preflight = await provider.preflight();
    assert.ok(preflight.ok, preflight.ok ? "" : `${preflight.error.kind}: ${preflight.error.message}`);
    const result = await provider.decide(input);
    assert.ok(result.usage.inputTokens > 0);
    assert.ok(
      ["click", "done", "navigate", "scroll", "back", "press"].includes(result.decision.type),
      result.decision.type,
    );
  });
});
