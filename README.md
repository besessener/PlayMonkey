# PlayMonkey

![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/browser-Playwright-2EAD33?logo=playwright&logoColor=white)
![Biome](https://img.shields.io/badge/lint-Biome-60A5FA?logo=biome&logoColor=white)
![Knip](https://img.shields.io/badge/dead%20code-Knip-000000?logo=knip&logoColor=white)
![node:test](https://img.shields.io/badge/tested%20with-node%3Atest-339933?logo=nodedotjs&logoColor=white)
![Gitleaks](https://img.shields.io/badge/secrets-Gitleaks-blue?logo=git&logoColor=white)
![zizmor](https://img.shields.io/badge/workflow%20security-zizmor-blue?logo=githubactions&logoColor=white)
[![CI](https://github.com/besessener/PlayMonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/besessener/PlayMonkey/actions/workflows/ci.yml)
[![CodeQL](https://github.com/besessener/PlayMonkey/actions/workflows/codeql.yml/badge.svg)](https://github.com/besessener/PlayMonkey/actions/workflows/codeql.yml)
[![Last commit](https://img.shields.io/github/last-commit/besessener/PlayMonkey)](https://github.com/besessener/PlayMonkey/commits/main)
[![License: MIT](https://img.shields.io/github/license/besessener/PlayMonkey)](LICENSE)

***Let a monkey loose on your test environment.***

`monkey` is a command line tool that drives a real browser with Playwright against a website in a **throwaway test
environment**. It clicks, types and submits its way through the site with seeded randomness and reports what breaks,
with the steps to reproduce it. An LLM steps in only when the random monkey gets stuck.

- **Seeded random monkey** – clicks links and buttons, fills forms with valid and nasty values; the same seed gives
  the same run.
- **Findings, not noise** – uncaught exceptions, console errors, HTTP 4xx/5xx, crashes, hangs, error pages, layout
  overflow and failed downloads, each reported once with a screenshot, a trace and a replayable action log.
- **An LLM only when stuck** – optional; cookie banners, dialogs or forms that need valid data get a few model
  decisions, and if the model fails the monkey simply goes on.
- **Test environments only** – no guardrails by design: it will click "Delete" and submit every form
  ([ground rules](docs/explanation/ground-rules.md)). Not a test-case generator, visual regression or load test.

> **Status:** milestone M4: the seeded random monkey with oracles, reports and replay; Claude on Microsoft Foundry
> or any OpenAI-compatible endpoint as the LLM for stuck situations; cookie banners, native dialogs, iframes,
> popups, file uploads and downloads handled; parallel runs per role and seed; a CI example. See the
> [roadmap](docs/explanation/roadmap.md).

## Installation

Requires Node.js 22.18 or newer and a Playwright browser. In your own project, install it as a dev dependency:

```sh
npm install --save-dev github:besessener/PlayMonkey#v0.4.0
npx playwright install chromium          # on Linux CI: add --with-deps
```

To try it first against the bundled fixture site with seeded bugs:

```sh
git clone https://github.com/besessener/PlayMonkey.git && cd PlayMonkey
npm ci                                   # installs and builds
npx playwright install chromium
PORT=8080 npm run fixture &              # the fixture site, in the background
export FIXTURE_URL=http://127.0.0.1:8080 FIXTURE_USER=monkey FIXTURE_PASS=banana-split
npx monkey run fixtures/configs/fixture.json
```

It prints the seed, one summary per role, every finding, and where the report is:
`fixtures/configs/monkey-report/report.html`. Step by step: [getting started](docs/tutorials/getting-started.md).
Releases and changes: [GitHub Releases](https://github.com/besessener/PlayMonkey/releases).

## Usage

```sh
monkey run config.json         # explore the site and report findings
monkey replay actions.json     # re-execute a recorded run, without an LLM
monkey preflight config.json   # check the configured LLM endpoint
monkey run config.json --watch # spectator mode: watch it live, e.g. for a demo
```

Exit codes: `0` no findings, `1` findings, `2` tool or config error, or a run that did not complete; `2` takes
precedence over `1`. A minimal config:

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

Secrets come from environment variables (`${VAR}`) and are masked in all output. Next steps:
[configure login](docs/how-to/configure-login.md), [configure the LLM](docs/how-to/configure-llm.md),
[run in parallel](docs/how-to/run-in-parallel.md), [run in CI](docs/how-to/run-in-ci.md) and
[reproduce a finding](docs/how-to/reproduce-a-finding.md); every key: [configuration](docs/reference/configuration.md).

## Development

Requires Node.js 22.18 or newer.

```sh
npm ci
npx playwright install chromium
npm run check
```

Details: [development setup](docs/tutorials/development-setup.md), [commands](docs/reference/commands.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

Website: <https://besessener.github.io/PlayMonkey/>. The full documentation is in [docs/](docs/README.md), organised
by [Diátaxis](https://diataxis.fr/):

- **[Tutorials](docs/README.md#tutorials)** – step by step to a first success, e.g. [getting started](docs/tutorials/getting-started.md)
- **[How-to guides](docs/README.md#how-to-guides)** – reach one goal, e.g. [configure login](docs/how-to/configure-login.md) or [configure the LLM](docs/how-to/configure-llm.md)
- **[Reference](docs/README.md#reference)** – look up exact behaviour, e.g. [configuration](docs/reference/configuration.md) or [commands](docs/reference/commands.md)
- **[Explanation](docs/README.md#explanation)** – understand why, e.g. [architecture](docs/explanation/architecture.md) or [ground rules](docs/explanation/ground-rules.md)

## Related projects

PlayMonkey, flakipype and Archivist started from the same agentic idea and share their ground rules, quality gates
and documentation layout:

- [flakipype](https://github.com/besessener/flakipype) – find, explain and fix flaky GitHub Actions pipelines.
- [Archivist](https://github.com/besessener/Archivist) – a personal, agentic AI archivist for Windows (in German).

## License

MIT, see [LICENSE](LICENSE).
