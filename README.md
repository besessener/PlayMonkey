# PlayMonkey

`monkey` is a TypeScript CLI that drives a real browser (Playwright) against a website in a **throwaway test
environment** and looks for bugs through seeded random interaction, with an LLM stepping in only when the random
monkey gets stuck.

> Status: early scaffold. `monkey run` and `monkey replay` are stubs; see the
> [epic](https://github.com/besessener/PlayMonkey/issues/1) for the roadmap.

## Usage

```
monkey run <config.json>      Explore the site described by the config and report findings.
monkey replay <actions.json>  Re-execute a recorded action log and check which findings recur.
monkey --help | --version
```

### Exit codes

| Code | Meaning              |
| ---- | -------------------- |
| `0`  | no findings          |
| `1`  | findings present     |
| `2`  | tool or config error |

## Development

Requirements: Node.js 22.18 or newer for development (the tests run TypeScript directly via Node's built-in type
stripping, which is on by default from 22.18). The built CLI runs on any Node.js 22.

```sh
npm ci
npx playwright install chromium   # browsers for later end-to-end tests
npm run build                     # tsc -> dist/
npm test                          # builds, then runs node:test on test/**/*.test.ts
npm run lint                      # biome ci + typecheck of src and tests
npm run format                    # biome format + safe fixes
```

### Tooling choices

- **Test runner: `node:test`.** It ships with Node, so it adds no dependency, and with Node's type stripping the
  tests import the `.ts` sources directly without a build or loader step. Vitest would add a large dependency tree for
  features (watch UI, module mocking) this project does not need.
- **Lint and format: Biome.** One dependency and one config file instead of ESLint + Prettier + plugins.
- **TypeScript:** strict mode, `erasableSyntaxOnly` (no enums or namespaces, so Node can strip types), and
  `rewriteRelativeImportExtensions` so sources import `./x.ts` and the build emits `./x.js`.
- **Runtime dependencies:** `playwright` and `ajv` (JSON Schema validation) only. Argument parsing uses
  `node:util` `parseArgs`.

### Layout

```
src/cli/           CLI entry (bin) and argument parsing
src/exit-codes.ts  exit code constants
src/{config,auth,snapshot,monkey,oracles,report,llm}/   added by the follow-up issues
fixtures/site/     local fixture site for end-to-end tests (follow-up issue)
test/              node:test suites (*.test.ts)
```
