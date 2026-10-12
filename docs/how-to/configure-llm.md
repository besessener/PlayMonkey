# Configure the LLM

The monkey runs without an LLM. With an `llm` section it hands the next few decisions to a model when it is stuck;
see [the LLM](../explanation/llm.md) for when and how. Today's backend is **`anthropic-foundry`**: Claude models
deployed in Microsoft Foundry, called through the official Anthropic SDK's Foundry client
(`@anthropic-ai/foundry-sdk`).

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
Azure agreement, there is no built-in price list. The report's [LLM usage](../reference/report.md#llm) shows calls,
tokens, cache reads, retries, fallbacks and latency per role.

## Thinking and effort

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
| `forbidden` | 403 | The identity needs a role such as **Foundry User** (formerly Azure AI User) on the resource. |
| `notFound` | 404 | `llm.deployment` must be the deployment name, not the model ID; `llm.baseUrl` must end in `/anthropic`. |
| `rateLimited` | 429 | Wait, or raise the deployment's quota. Requests are retried `llm.maxRetries` times first. |
| `badRequest` | 400 | An `llm.options` value the model does not accept. |
| `server` | 5xx | The endpoint had a problem; try again later. |
| `invalid` | 200 | The model answered without a valid tool call: tool calling is unsupported or broken on this endpoint. |

For anything else, `llm.debugLog: true` writes every prompt and response to `llm-debug.jsonl` in the report directory.
