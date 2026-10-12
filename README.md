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

## Configuration

`monkey run` takes one JSON file. Minimal example:

```json
{
  "baseUrl": "https://test.example.org",
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    },
    { "name": "user", "storageState": "./states/user.json" }
  ]
}
```

The schema with every key, type, default and description is `src/config/schema.ts`. Rules:

- **Defaults:** random `seed` (printed at startup; set it to reproduce a run), `limits.maxSteps` 500,
  `limits.maxMinutes` 20, `browser.engine` `chromium`, `browser.viewport` `[1280, 800]`, `browser.headless` `true`,
  `stayOnDomain` `true`, all `oracles` on, `report.dir` `./monkey-report`. `auth` may be omitted (anonymous run);
  `llm` may be omitted (pure random monkey).
- **Unknown keys are rejected**, not warned about: a typo such as `maxStep` would otherwise silently fall back to a
  default. Only `testData` and `auth[].fields` take arbitrary keys. A top-level `$schema` key is allowed for editors.
- **`null` is rejected**; omit a key to get its default.
- **Each `auth` role** uses either `fields` + `loginUrl` + `submit`, or `storageState`, never both. Role names must be
  unique.
- **Relative paths** (`storageState`, `report.dir`) are resolved against the directory of the config file.
- **Secrets:** `${VAR}` in any string value is replaced with the environment variable `VAR`, also inside longer
  strings (`"https://${HOST}/app"`). Substituted values are not expanded again. An unset variable is an error naming
  the config path and the variable, never a value. Everything that came from a placeholder is shown as `***` in logs,
  reports and error messages.
- **Errors:** all problems are listed at once, each with its path (e.g. `auth[0].fields.password`), and the exit code
  is `2`.

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
npm run fixture                   # start the local fixture site (see fixtures/README.md)
```

Browser tests launch the Chromium that matches the installed Playwright version. Where that cannot be installed,
point them at another Chromium with `CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm test`.

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
src/config/        config schema, ${VAR} resolution, validation, secret masking
src/exit-codes.ts  exit code constants
src/{auth,snapshot,monkey,oracles,report,llm}/   added by the follow-up issues
fixtures/site/     local fixture site with seeded bugs for end-to-end tests
fixtures/configs/  example config for the fixture site
test/              node:test suites (*.test.ts)
```
