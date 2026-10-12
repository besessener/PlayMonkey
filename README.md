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

**What it is:** exploratory testing that runs unattended: uncaught exceptions, console errors, HTTP 4xx/5xx, crashes,
hangs, error pages, layout overflow and failed downloads, each reported once with a screenshot, a trace and a
replayable action log. **What it is not:** a test-case generator, visual regression, a load or performance test, or
anything for production. It has no guardrails by design: it will click "Delete" and submit every form, so point it
only at environments you can throw away ([ground rules](docs/explanation/ground-rules.md)).

> **Status:** milestone M4: the seeded random monkey with oracles, reports and replay; Claude on Microsoft Foundry
> or any OpenAI-compatible endpoint as the LLM for stuck situations; cookie banners, native dialogs, iframes,
> popups, file uploads and downloads handled; parallel runs per role and seed; a CI example. See the
> [roadmap](docs/explanation/roadmap.md).

## Quick start

Requires Node.js 22.18 or newer and a Playwright browser. From a clean checkout, against the bundled fixture site:

```sh
git clone https://github.com/besessener/PlayMonkey.git && cd PlayMonkey
npm ci                                   # installs and builds
npx playwright install chromium          # on Linux CI: add --with-deps
PORT=8080 npm run fixture &              # the fixture site with seeded bugs, in the background
export FIXTURE_URL=http://127.0.0.1:8080 FIXTURE_USER=monkey FIXTURE_PASS=banana-split
npx monkey run fixtures/configs/fixture.json
```

It prints the seed, one summary per role, every finding, and where the report is:
`fixtures/configs/monkey-report/report.html` (open it in a browser). The whole walk-through:
[getting started](docs/tutorials/getting-started.md). In your own project, install it as a dev dependency with
`npm install --save-dev github:besessener/PlayMonkey#v0.4.0`. Releases and changes: [CHANGELOG](CHANGELOG.md).

## Usage

```sh
monkey run config.json         # explore the site and report findings
monkey replay actions.json     # re-execute a recorded run, without an LLM
monkey preflight config.json   # check the configured LLM endpoint
monkey run config.json --watch # spectator mode: watch it live, e.g. for a demo
```

`--watch` opens a visible, slowed-down browser that outlines each element before acting and prints every step; see
[watch a run](docs/how-to/watch-a-run.md).

Exit codes: `0` no findings, `1` findings, `2` tool or config error, or a run that did not complete (failed login,
crash); `2` takes precedence over `1`. Details: [commands](docs/reference/commands.md).

A minimal config:

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

Secrets come from environment variables (`${VAR}`) and are masked in all output. Every key:
[configuration](docs/reference/configuration.md); logins and roles: [configure login](docs/how-to/configure-login.md).

### Several roles and seeds at once

```json
"seeds": [1, 2, 3],
"parallel": 3
```

runs every role with every seed, three at a time, each in its own browser context, into `<role>/<seed>/`, with one
combined report that shows each problem once and where it was found ("found in admin, user"). See
[run in parallel](docs/how-to/run-in-parallel.md).

### Reproducing findings

Each finding lists the steps that led to it. `npx playwright show-trace <role>/trace.zip` shows them in detail, and
`monkey replay <role>/actions.json --config config.json` repeats them without randomness or LLM. See
[reproduce a finding](docs/how-to/reproduce-a-finding.md).

### CI

[`.github/workflows/monkey.yml`](.github/workflows/monkey.yml) is a GitHub Actions example that installs the
browser, runs the monkey with secrets from the CI secret store, uploads the report as an artifact and acts on the
exit code. It runs in this repository's CI against the fixture site; see [run in CI](docs/how-to/run-in-ci.md).

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

Two backends: `anthropic-foundry` (Claude on Microsoft Foundry) and `openai` (OpenAI models on Foundry or any
OpenAI-compatible endpoint, through the Responses API or Chat Completions):

```json
"llm": {
  "provider": "openai",
  "baseUrl": "https://<resource>.openai.azure.com/openai/v1",
  "deployment": "<deployment-name>",
  "apiKey": "${FOUNDRY_API_KEY}"
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
| `forbidden` | 403 | Give the identity a role such as Foundry User (Cognitive Services OpenAI User for `openai`) on the resource. |
| `notFound` | 404 | `llm.deployment` is the deployment name, not the model ID; `llm.baseUrl` ends in `/anthropic` or is the full OpenAI-compatible base URL (`…/openai/v1`). With `openai`, try the other `llm.options.api`. |
| `rateLimited` | 429 | Wait or raise the quota; requests are retried `llm.maxRetries` times first. |
| `badRequest` | 400 | Remove an `llm.options` value the model rejects; with `openai`, try the other `llm.options.api`. |
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

See [CONTRIBUTING.md](CONTRIBUTING.md), [development setup](docs/tutorials/development-setup.md) and
[commands](docs/reference/commands.md). Adding an oracle: [oracles](docs/explanation/oracles.md#adding-an-oracle).

## Documentation

Website: <https://besessener.github.io/PlayMonkey/>. The full documentation is in [docs/](docs/README.md), organised
by [Diátaxis](https://diataxis.fr/):

- **[Tutorials](docs/README.md#tutorials)** – step by step to a first success, e.g. [getting started](docs/tutorials/getting-started.md)
- **[How-to guides](docs/README.md#how-to-guides)** – reach one goal, e.g. [configure login](docs/how-to/configure-login.md)
- **[Reference](docs/README.md#reference)** – look up exact behaviour, e.g. [configuration](docs/reference/configuration.md) or [commands](docs/reference/commands.md)
- **[Explanation](docs/README.md#explanation)** – understand why, e.g. [architecture](docs/explanation/architecture.md) or [ground rules](docs/explanation/ground-rules.md)

## License

MIT, see [LICENSE](LICENSE).
