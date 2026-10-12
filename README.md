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

> **Status:** early development. Config, login per role and the seeded random monkey work; oracles, action log
> and report are being built, see the [roadmap](docs/explanation/roadmap.md).

## Usage

```sh
monkey run config.json        # explore the site and report findings
monkey replay actions.json    # re-execute a recorded run, without an LLM
```

Exit codes: `0` no findings, `1` findings, `2` tool or config error.

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
