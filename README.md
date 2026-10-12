# PlayMonkey

[![CI](https://github.com/besessener/PlayMonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/besessener/PlayMonkey/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/browser-Playwright-2EAD33?logo=playwright&logoColor=white)
![Biome](https://img.shields.io/badge/lint-Biome-60A5FA?logo=biome&logoColor=white)
[![License: MIT](https://img.shields.io/github/license/besessener/PlayMonkey)](LICENSE)

***Let a monkey loose on your test environment.***

`monkey` is a command line tool that drives a real browser with Playwright against a website in a **throwaway test
environment**. It clicks, types and submits its way through the site with seeded randomness and reports what breaks,
with the steps to reproduce it. An LLM steps in only when the random monkey gets stuck.

> **Status:** milestone M2: the seeded random monkey with oracles, reports and replay, plus Claude on Microsoft
> Foundry as the LLM for stuck situations. Next: an OpenAI-compatible backend and hardening, see the
> [roadmap](docs/explanation/roadmap.md).

## Usage

```sh
monkey run config.json         # explore the site and report findings
monkey replay actions.json     # re-execute a recorded run, without an LLM
monkey preflight config.json   # check the configured LLM endpoint
monkey run config.json --watch # spectator mode: watch it live, e.g. for a demo
```

`--watch` opens a visible, slowed-down browser that outlines each element before acting and prints every step; see
[watch a run](docs/how-to/watch-a-run.md). Exit codes: `0` no findings, `1` findings, `2` tool or config error.

```json
{
  "baseUrl": "https://test.example.org",
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    }
  ]
}
```

Secrets come from environment variables (`${VAR}`) and are masked in all output. Step by step:
[getting started](docs/tutorials/getting-started.md).

## LLM

Optional. When the random monkey is stuck (a dialog or cookie banner, a form that rejects its input, an expired
session, no new pages), it hands a few decisions to an LLM; if the LLM fails, the monkey simply goes on.

```json
"llm": {
  "provider": "anthropic-foundry",
  "baseUrl": "https://<resource>.services.ai.azure.com/anthropic",
  "deployment": "<deployment-name>",
  "apiKey": "${FOUNDRY_API_KEY}",
  "maxCalls": 200
}
```

Secrets never enter a prompt: the model refers to login fields and test data by placeholders such as
`{{admin.password}}`, filled in after it answered. The report shows calls, tokens, fallbacks and, with
`llm.pricing`, an estimated cost. Details: [configure the LLM](docs/how-to/configure-llm.md) and
[how the LLM is used](docs/explanation/llm.md).

### Troubleshooting

`monkey run` checks the endpoint before opening a browser (`monkey preflight` does only that): one probe request
that must come back as a tool call. On failure it prints the cause and a hint and exits with `2`
(`"required": false` continues without LLM instead).

| Cause | Status | Fix |
| --- | --- | --- |
| `unreachable`, `tls`, `timeout` | – | Check `llm.baseUrl`, DNS, proxy, certificates (`NODE_EXTRA_CA_CERTS`), `llm.timeoutMs`. |
| `auth` | 401 | `llm.apiKey` must be a key of this resource. |
| `forbidden` | 403 | Give the identity a role such as Foundry User on the resource. |
| `notFound` | 404 | `llm.deployment` is the deployment name, not the model ID; `llm.baseUrl` ends in `/anthropic`. |
| `rateLimited` | 429 | Wait or raise the quota; requests are retried `llm.maxRetries` times first. |
| `badRequest` | 400 | Remove an `llm.options` value the model rejects. |
| `invalid` | 200 | The model did not return a tool call: tool calling is unsupported on this endpoint. |

### Adding a backend

Backends implement one interface (`src/llm/provider.ts`) and share the tools, prompt and validation:

```ts
interface LlmProvider {
  readonly name: string;
  preflight(): Promise<PreflightResult>; // probe: must come back as a `ping` tool call
  decide(input: DecideInput): Promise<DecideResult>; // one action as a tool call, validated by parseToolCall
}
```

See [adding a backend](docs/explanation/llm.md#adding-a-backend).

## Development

Requires Node.js 22.18 or newer.

```sh
npm ci
npx playwright install chromium
npm test
npm run lint
```

Details: [development setup](docs/tutorials/development-setup.md) and [commands](docs/reference/commands.md).

## Documentation

Website: <https://besessener.github.io/PlayMonkey/>. The full documentation is in [docs/](docs/README.md), organised
by [Diátaxis](https://diataxis.fr/):

- **[Tutorials](docs/README.md#tutorials)** – step by step to a first success, e.g. [getting started](docs/tutorials/getting-started.md)
- **[How-to guides](docs/README.md#how-to-guides)** – reach one goal, e.g. [configure login](docs/how-to/configure-login.md)
- **[Reference](docs/README.md#reference)** – look up exact behaviour, e.g. [configuration](docs/reference/configuration.md) or [commands](docs/reference/commands.md)
- **[Explanation](docs/README.md#explanation)** – understand why, e.g. [architecture](docs/explanation/architecture.md) or [ground rules](docs/explanation/ground-rules.md)

## License

MIT, see [LICENSE](LICENSE).
