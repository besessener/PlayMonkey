# Configure the LLM

The monkey runs without an LLM. With an `llm` section it hands the next few decisions to a model when it is stuck;
see [the LLM](../explanation/llm.md) for when and how. There are two backends:

- **`anthropic-foundry`**: Claude models deployed in Microsoft Foundry, called through the official Anthropic SDK's
  Foundry client (`@anthropic-ai/foundry-sdk`).
- **`openai`**: OpenAI models deployed in Microsoft Foundry, or any other OpenAI-compatible endpoint, called through
  the official `openai` SDK.

## Claude on Microsoft Foundry

1. Deploy a Claude model in your Foundry resource (Foundry portal → model catalog → Deploy). Note the **deployment
   name**; it defaults to the model ID but can be anything.
2. On the deployment's details, copy the **Target URI** and the **Key**.
3. Configure:

   ```json
   "llm": {
     "provider": "anthropic-foundry",
     "baseUrl": "https://<resource>.services.ai.azure.com/anthropic",
     "deployment": "<deployment-name>",
     "apiKey": "${FOUNDRY_API_KEY}"
   }
   ```

   - `baseUrl` ends in `/anthropic`. The SDK appends `/v1/messages` itself; a URL copied from the portal that ends in
     `/v1` or `/v1/messages` is shortened, with a notice.
   - `deployment` is the deployment name, which is sent as the model. No model ID is built in.
   - `apiKey` comes from the environment; it is masked everywhere and never part of a prompt or error message.

4. Check it: `FOUNDRY_API_KEY=… monkey preflight config.json`.

Only API keys are supported. Microsoft Entra ID can be added later as an alternative to `apiKey` without changing
existing configs.

## OpenAI models and other OpenAI-compatible endpoints

1. Deploy a model in your Foundry resource and note its **deployment name**.
2. Find the OpenAI-compatible **base URL**. It depends on the endpoint, so it is configured in full and never built
   by PlayMonkey:

   | Endpoint | Base URL |
   | --- | --- |
   | Azure OpenAI v1 on the resource | `https://<resource>.openai.azure.com/openai/v1` |
   | The same on a Foundry resource | `https://<resource>.services.ai.azure.com/openai/v1` |
   | Any other OpenAI-compatible server | Whatever it documents, e.g. `https://api.openai.com/v1` |

3. Configure:

   ```json
   "llm": {
     "provider": "openai",
     "baseUrl": "https://<resource>.openai.azure.com/openai/v1",
     "deployment": "<deployment-name>",
     "apiKey": "${FOUNDRY_API_KEY}"
   }
   ```

   - The v1 API needs no `api-version`; a query copied with the URL is dropped, and so is a trailing `/responses` or
     `/chat/completions` (with a notice), since the SDK appends the path itself.
   - The key is sent as `Authorization: Bearer`, which Azure accepts for API keys on the v1 API.
   - `OPENAI_BASE_URL`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` in the environment are ignored: only the config
     decides where requests go.

4. Check it: `FOUNDRY_API_KEY=… monkey preflight config.json`.

### Responses API or Chat Completions

Microsoft recommends the **Responses API** for Azure OpenAI models, and it is the default. Models from other
providers on Foundry, and many self-hosted OpenAI-compatible servers, only offer **Chat Completions**; switch with:

```json
"options": { "api": "chat" }
```

Both use function calling with the same tools; PlayMonkey does not force a tool choice and validates every call
itself, so the tools are sent without OpenAI's `strict` mode. The Responses API is called with `store: false`, so
prompts (which contain page content) are not kept on the server. When the preflight answers `notFound` or
`badRequest` on one surface, try the other.

`llm.options.effort` is sent as the reasoning effort (`reasoning.effort`, `reasoning_effort`); `thinking` is for
Claude only and rejected with `openai`. OpenAI caches long prompt prefixes automatically; cache reads show up as
`cachedTokens`.

## Budget and cost

LLM calls cost money and time, so the monkey only asks when it is stuck, and you can cap a run:

```json
"llm": {
  "...": "...",
  "maxCalls": 200,
  "maxTokens": 2000000,
  "pricing": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3 }
}
```

When a budget is spent, the run continues as a pure monkey and the console and report say when that happened.
`pricing` turns token counts into an **estimated** cost in the report; take the prices of your deployment from your
Azure agreement, there is no built-in price list. The report's [LLM usage](../reference/bericht.md#llm) shows calls,
tokens, cache reads, retries, fallbacks and latency per role.

## Thinking and effort

This section is about `anthropic-foundry`; for `openai` see
[Responses API or Chat Completions](#responses-api-or-chat-completions).

Recent Claude models think before answering by default, and some reject turning it off. PlayMonkey therefore sends no
`thinking` setting unless you choose one, and thinking tokens count against `llm.options.maxOutputTokens` (default
4096) and are billed as output. To make decisions faster and cheaper on a model that allows it:

```json
"options": { "thinking": "disabled", "effort": "low" }
```

Which combinations a model accepts is in Anthropic's
[thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking); a rejected setting shows
up in the preflight as `badRequest`.

## Troubleshooting

`monkey run` runs the preflight before any browser work; `monkey preflight` runs only it. The probe asks the model
to call a `ping` tool and checks that a well-formed tool call comes back. A failure prints the provider, the URL
without credentials or query, the HTTP status, the cause and a hint, and exits with code `2`. With
`"required": false` the run warns and continues as a pure random monkey instead.

| Cause | Typical status | Check |
| --- | --- | --- |
| `unreachable` | – | `llm.baseUrl`, DNS, proxy and firewall. |
| `tls` | – | The certificate chain; behind a TLS-inspecting proxy set `NODE_EXTRA_CA_CERTS`. |
| `timeout` | – | The network, or raise `llm.timeoutMs`. |
| `auth` | 401 | `llm.apiKey` must be a key of this resource. |
| `forbidden` | 403 | The identity needs a role such as **Foundry User** (formerly Azure AI User) on the resource; for `openai`, **Cognitive Services OpenAI User**. |
| `notFound` | 404 | `llm.deployment` must be the deployment name, not the model ID; `llm.baseUrl` must end in `/anthropic` (`anthropic-foundry`) or be the full base URL such as `…/openai/v1` (`openai`). With `openai`, the deployment may not offer this API surface: try `llm.options.api`. |
| `rateLimited` | 429 | Wait, or raise the deployment's quota. Requests are retried `llm.maxRetries` times first. |
| `badRequest` | 400 | An `llm.options` value the model does not accept; with `openai` also an API surface or tool calling the deployment does not support. |
| `server` | 5xx | The endpoint had a problem; try again later. |
| `invalid` | 200 | The model answered without a valid tool call: tool calling is unsupported or broken on this endpoint. |

For anything else, `llm.debugLog: true` writes every prompt and response to `llm-debug.jsonl` in the report directory.
