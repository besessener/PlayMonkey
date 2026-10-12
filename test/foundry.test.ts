import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LlmConfig, parseConfig } from "../src/config/config.ts";
import { AnthropicFoundryProvider, normalizeFoundryBaseUrl } from "../src/llm/anthropic-foundry.ts";
import { runPreflight } from "../src/llm/preflight.ts";
import type { DecideInput, LlmError, LlmErrorKind } from "../src/llm/provider.ts";
import { serializeSnapshot } from "../src/snapshot/serialize.ts";
import type { Snapshot } from "../src/snapshot/snapshot.ts";

const KEY = "sk-foundry-0123456789abcdef";

function llmConfig(llm: Record<string, unknown> = {}): {
  llm: LlmConfig;
  secrets: ReturnType<typeof parseConfig>["secrets"];
} {
  const { config, secrets } = parseConfig(
    JSON.stringify({
      baseUrl: "https://test.example.org",
      llm: {
        provider: "anthropic-foundry",
        baseUrl: "https://res.services.ai.azure.com/anthropic/v1",
        deployment: "my-claude-deployment",
        apiKey: "${FOUNDRY_API_KEY}",
        maxRetries: 2,
        ...llm,
      },
    }),
    { env: { FOUNDRY_API_KEY: KEY } },
  );
  return { llm: config.llm as LlmConfig, secrets };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that answers with the given responses in turn and records every request. */
function mockFetch(...responses: (Response | Error | ((init?: RequestInit) => Promise<Response>))[]) {
  const requests: Captured[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init) : next;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "1", ...headers },
  });
}

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return json(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "my-claude-deployment",
    content,
    stop_reason: "tool_use",
    stop_details: null,
    usage: { input_tokens: 1200, output_tokens: 35, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    ...extra,
  });
}

const apiError = (status: number, type: string, text: string) =>
  json(status, { type: "error", error: { type, message: text } });

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

describe("anthropic-foundry provider", () => {
  it("normalizes the base URL", () => {
    assert.deepEqual(normalizeFoundryBaseUrl("https://r.services.ai.azure.com/anthropic"), {
      url: "https://r.services.ai.azure.com/anthropic",
    });
    assert.deepEqual(normalizeFoundryBaseUrl("https://r.services.ai.azure.com/anthropic/"), {
      url: "https://r.services.ai.azure.com/anthropic",
    });
    assert.deepEqual(normalizeFoundryBaseUrl("https://r.services.ai.azure.com/anthropic/v1/"), {
      url: "https://r.services.ai.azure.com/anthropic",
      stripped: "/v1",
    });
    assert.deepEqual(normalizeFoundryBaseUrl("https://r.services.ai.azure.com/anthropic/v1/messages?x=1"), {
      url: "https://r.services.ai.azure.com/anthropic",
      stripped: "/v1/messages",
    });
  });

  it("strips /v1, uses the deployment as model and parses the tool call and usage", async () => {
    const { llm } = llmConfig();
    const { fetch, requests } = mockFetch(
      message([
        { type: "text", text: "Opening the form." },
        { type: "tool_use", id: "toolu_1", name: "click", input: { ref: "e3" } },
      ]),
    );
    const notices: string[] = [];
    const provider = new AnthropicFoundryProvider(llm, { fetch, log: (line) => notices.push(line) });
    const result = await provider.decide(input);

    assert.deepEqual(result.decision, { type: "click", ref: "e3" });
    assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 35, cachedTokens: 900, cacheWriteTokens: 0 });
    assert.equal(result.retries, 0);
    assert.match(notices.join("\n"), /removed "\/v1" from llm\.baseUrl/);

    const [request] = requests as [Captured];
    assert.equal(request.url, "https://res.services.ai.azure.com/anthropic/v1/messages");
    assert.equal(request.headers.get("x-api-key"), KEY);
    assert.equal(request.body.model, "my-claude-deployment");
    assert.deepEqual(request.body.tool_choice, { type: "auto" });
    assert.equal("thinking" in request.body, false);
    assert.equal(request.body.max_tokens, 4096);
    const tools = request.body.tools as { name: string; input_schema: { additionalProperties: boolean } }[];
    assert.equal(tools.length, 10);
    assert.ok(tools.every((tool) => tool.input_schema.additionalProperties === false));
    const system = request.body.system as { text: string; cache_control: unknown }[];
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
    const messages = request.body.messages as { role: string; content: string }[];
    assert.match(messages[0]?.content ?? "", /e3 link "Contact form" -> \/form/);
    assert.ok(!JSON.stringify(request.body).includes(KEY));
  });

  it("sends the optional thinking and effort settings", async () => {
    const { llm } = llmConfig({ options: { thinking: "disabled", effort: "low", maxOutputTokens: 512 } });
    const { fetch, requests } = mockFetch(message([{ type: "tool_use", id: "t", name: "back", input: {} }]));
    await new AnthropicFoundryProvider(llm, { fetch }).decide(input);
    assert.deepEqual(requests[0]?.body.thinking, { type: "disabled" });
    assert.deepEqual(requests[0]?.body.output_config, { effort: "low" });
    assert.equal(requests[0]?.body.max_tokens, 512);
  });

  it("retries 429 and 5xx through the SDK", async () => {
    const { llm } = llmConfig();
    const { fetch, requests } = mockFetch(
      apiError(429, "rate_limit_error", "slow down"),
      apiError(529, "overloaded_error", "overloaded"),
      message([{ type: "tool_use", id: "t", name: "back", input: {} }]),
    );
    const result = await new AnthropicFoundryProvider(llm, { fetch }).decide(input);
    assert.deepEqual(result.decision, { type: "back" });
    assert.equal(result.retries, 2);
    assert.equal(requests.length, 3);
  });

  it("does not retry other 4xx", async () => {
    const { llm } = llmConfig();
    const { fetch, requests } = mockFetch(apiError(400, "invalid_request_error", "tool_choice not supported"));
    await assert.rejects(new AnthropicFoundryProvider(llm, { fetch }).decide(input), (error: LlmError) => {
      assert.equal(error.kind, "badRequest");
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it("treats a refusal, a truncated answer and text only as failed decisions", async () => {
    const { llm } = llmConfig();
    const cases: [Response, LlmErrorKind][] = [
      [
        message([{ type: "text", text: "" }], {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: null },
        }),
        "refusal",
      ],
      [message([{ type: "tool_use", id: "t", name: "click", input: {} }], { stop_reason: "max_tokens" }), "maxTokens"],
      [message([{ type: "text", text: "I would click the link." }], { stop_reason: "end_turn" }), "invalid"],
      [message([{ type: "tool_use", id: "t", name: "click", input: { ref: "e77" } }]), "invalid"],
    ];
    for (const [response, kind] of cases) {
      const { fetch } = mockFetch(response);
      await assert.rejects(new AnthropicFoundryProvider(llm, { fetch }).decide(input), (error: LlmError) => {
        assert.equal(error.kind, kind);
        // The failed call still cost tokens.
        assert.equal(error.usage?.inputTokens, 1200);
        return true;
      });
    }
  });

  it("never puts the API key into error messages", async () => {
    const { llm } = llmConfig({ maxRetries: 0 });
    const { fetch } = mockFetch(apiError(401, "authentication_error", `invalid x-api-key ${KEY}`));
    await assert.rejects(new AnthropicFoundryProvider(llm, { fetch }).decide(input), (error: LlmError) => {
      assert.equal(error.kind, "auth");
      assert.ok(!error.message.includes(KEY), error.message);
      return true;
    });
  });

  it("ignores ANTHROPIC_FOUNDRY_* variables in the environment", async () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = "other-resource";
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = "https://other.example.com/anthropic";
    try {
      const { llm } = llmConfig();
      const { fetch, requests } = mockFetch(message([{ type: "tool_use", id: "t", name: "back", input: {} }]));
      await new AnthropicFoundryProvider(llm, { fetch }).decide(input);
      assert.equal(requests[0]?.url, "https://res.services.ai.azure.com/anthropic/v1/messages");
    } finally {
      process.env = saved;
    }
  });
});

describe("preflight", () => {
  const connectionError = (code: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  /** Never answers; rejects like fetch when the SDK aborts it on timeout. */
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    );

  const cases: {
    name: string;
    response: Response | Error | ((init?: RequestInit) => Promise<Response>);
    kind: LlmErrorKind;
    hint: RegExp;
    status?: number;
  }[] = [
    { name: "unreachable", response: connectionError("ENOTFOUND"), kind: "unreachable", hint: /not reachable/ },
    { name: "TLS", response: connectionError("CERT_HAS_EXPIRED"), kind: "tls", hint: /TLS handshake/ },
    {
      name: "401",
      response: apiError(401, "authentication_error", "bad key"),
      kind: "auth",
      hint: /check llm\.apiKey/,
      status: 401,
    },
    {
      name: "403",
      response: apiError(403, "permission_error", "no"),
      kind: "forbidden",
      hint: /Foundry User/,
      status: 403,
    },
    {
      name: "404",
      response: apiError(404, "not_found_error", "DeploymentNotFound"),
      kind: "notFound",
      hint: /llm\.deployment must be the Foundry deployment name, not the model ID/,
      status: 404,
    },
    {
      name: "429",
      response: apiError(429, "rate_limit_error", "busy"),
      kind: "rateLimited",
      hint: /rate limited/,
      status: 429,
    },
    {
      name: "text only",
      response: message([{ type: "text", text: "pong" }], { stop_reason: "end_turn" }),
      kind: "invalid",
      hint: /tool calling unsupported/,
    },
    { name: "timeout", response: hang, kind: "timeout", hint: /llm\.timeoutMs/ },
  ];

  for (const { name, response, kind, hint, status } of cases) {
    it(`reports ${name} with a hint and without the key`, async () => {
      const { llm, secrets } = llmConfig({
        maxRetries: 0,
        baseUrl: "https://user:pw@res.services.ai.azure.com/anthropic?code=abc",
      });
      const { fetch } = mockFetch(response);
      const provider = new AnthropicFoundryProvider({ ...llm, timeoutMs: 200 }, { fetch });
      const { result, message: text } = await runPreflight(provider, llm, secrets);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.kind, kind);
      assert.equal(result.error.status, status);
      assert.match(text, hint);
      assert.match(
        text,
        /^llm preflight failed: anthropic-foundry at https:\/\/res\.services\.ai\.azure\.com\/anthropic, deployment my-claude-deployment/,
      );
      if (status !== undefined) assert.match(text, new RegExp(`HTTP ${status}`));
      assert.ok(!text.includes(KEY) && !text.includes("pw@") && !text.includes("code=abc"), text);
    });
  }

  it("passes when the model calls ping", async () => {
    const { llm, secrets } = llmConfig();
    const { fetch, requests } = mockFetch(
      message([{ type: "tool_use", id: "t", name: "ping", input: { value: "x" } }]),
    );
    const { result, message: text } = await runPreflight(new AnthropicFoundryProvider(llm, { fetch }), llm, secrets);
    assert.equal(result.ok, true);
    assert.match(
      text,
      /^llm preflight ok: anthropic-foundry at https:\/\/res\.services\.ai\.azure\.com\/anthropic\/v1, deployment my-claude-deployment \(\d+ ms\)$/,
    );
    const tools = requests[0]?.body.tools as { name: string }[];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["ping"],
    );
    assert.deepEqual(requests[0]?.body.tool_choice, { type: "auto" });
  });
});

// Opt-in: one real call against a Foundry deployment.
const live = process.env.FOUNDRY_API_KEY !== undefined && process.env.FOUNDRY_BASE_URL !== undefined;
describe("anthropic-foundry against a real endpoint", {
  skip: live ? false : "set FOUNDRY_API_KEY and FOUNDRY_BASE_URL (and FOUNDRY_DEPLOYMENT)",
}, () => {
  it("decides on the fixture snapshot", async () => {
    const { llm } = llmConfig({
      baseUrl: process.env.FOUNDRY_BASE_URL,
      deployment: process.env.FOUNDRY_DEPLOYMENT ?? "claude-haiku-5-5",
    });
    const provider = new AnthropicFoundryProvider({ ...llm, apiKey: process.env.FOUNDRY_API_KEY as string });
    const result = await provider.decide(input);
    assert.ok(result.usage.inputTokens > 0);
    assert.ok(
      ["click", "done", "navigate", "scroll", "back", "press"].includes(result.decision.type),
      result.decision.type,
    );
  });
});
