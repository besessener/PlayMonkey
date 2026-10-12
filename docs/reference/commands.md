# Commands

## `monkey`

```text
monkey run <config.json>      Explore the site described by the config and report findings.
monkey replay <actions.json> [--config <config.json>] [--strict]
                              Re-execute a recorded action log and check which findings recur.
monkey preflight <config.json>
                              Check that the configured LLM endpoint works, without a browser.
monkey --help | -h
monkey --version | -v
```

| Command | Today |
| --- | --- |
| `run` | Validates the config, prints the seed, runs the [LLM preflight](../how-to/configure-llm.md#troubleshooting) when `llm` is set (before any browser work), then runs the random monkey with the [oracles](../explanation/oracles.md) for every role. Prints a summary per role, one line per finding, the trace path and the total number of findings; screenshots go to `<report.dir>/<role>/screenshots/`, the [action log](action-log.md) to `<report.dir>/<role>/actions.json`. Writes the [report](report.md) (`report.json`, self-contained `report.html`) and ends with the LLM usage (with `llm`), the counts per severity, the report path and the reason for the exit code. |
| `replay` | Executes an action log again in a fresh context for its role, without an LLM, runs the oracles and prints for each recorded finding whether it was `reproduced`, plus `new` findings. `--config` (`-c`) supplies login, browser and oracle settings and is required for roles that log in; `--strict` aborts at the first element that cannot be found instead of skipping it. Output goes to `replay/` next to the log. See [replay](../explanation/replay.md). |
| `preflight` | Validates the config and sends one probe request to the configured LLM that must come back as a tool call. Prints `llm preflight ok: …` and exits `0`, or the provider, sanitized URL, HTTP status, cause and a hint, and exits `2`, also with `llm.required: false`. A config without `llm` exits `2`. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings (also `--help`, `--version`). Replay: none of the recorded findings recurred. |
| `1` | Findings present. Replay: at least one recorded finding recurred. |
| `2` | Tool or config error: bad usage, unknown command or option, invalid config, a role that failed to log in (the other roles still run), a run that lost its browser, a failed LLM preflight (unless `llm.required` is `false`), an unavailable `llm.provider`. Replay: also an unreadable action log, an unsupported log version, an unset variable the log needs, a role missing from `--config`, or a `--strict` replay that could not find an element. |

## npm scripts

| Script | Does |
| --- | --- |
| `npm run build` | `tsc` from `src/` to `dist/`. |
| `npm test` | Builds, then `node --test "test/**/*.test.ts"`. |
| `npm run lint` | `biome ci .` and typechecks `src` and `test`. |
| `npm run typecheck` | Typechecks only. |
| `npm run format` | `biome check --write .`: formatting and safe fixes. |
| `npm run fixture` | Starts the fixture site until interrupted. |

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| any `${VAR}` in the config | `monkey run` | Secrets and other values substituted into the config. |
| `PORT` | `npm run fixture` | Fixed port for the fixture site; default is a free one. |
| `CHROMIUM_EXECUTABLE_PATH` | `monkey run`, tests | Launch this Chromium instead of the one installed for Playwright (engine `chromium` only). |
| `FOUNDRY_API_KEY`, `FOUNDRY_BASE_URL`, `FOUNDRY_DEPLOYMENT` | tests | Opt-in: run one real `decide` call against a Foundry deployment in `test/foundry.test.ts`; skipped unless the first two are set. |

`ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_BASE_URL` and `ANTHROPIC_FOUNDRY_RESOURCE`, which the Foundry SDK
reads on its own, are ignored: the endpoint and key come only from the config.
