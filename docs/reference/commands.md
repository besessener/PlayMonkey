# Commands

## `monkey`

```text
monkey run <config.json>      Explore the site described by the config and report findings.
monkey replay <actions.json> [--config <config.json>] [--strict]
                              Re-execute a recorded action log and check which findings recur.
monkey --help | -h
monkey --version | -v
```

| Command | Today |
| --- | --- |
| `run` | Validates the config, prints the seed, then runs the random monkey with the [oracles](../explanation/oracles.md) for every role. Prints a summary per role, one line per finding, the trace path and the total number of findings; screenshots go to `<report.dir>/<role>/screenshots/`, the [action log](action-log.md) to `<report.dir>/<role>/actions.json`. The full report (`report.json`, `report.html`) follows with #10. |
| `replay` | Executes an action log again in a fresh context for its role, without an LLM, runs the oracles and prints for each recorded finding whether it was `reproduced`, plus `new` findings. `--config` (`-c`) supplies login, browser and oracle settings and is required for roles that log in; `--strict` aborts at the first element that cannot be found instead of skipping it. Output goes to `replay/` next to the log. See [replay](../explanation/replay.md). |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings (also `--help`, `--version`). Replay: none of the recorded findings recurred. |
| `1` | Findings present. Replay: at least one recorded finding recurred. |
| `2` | Tool or config error: bad usage, unknown command or option, invalid config, a role that failed to log in (the other roles still run), a run that lost its browser. Replay: also an unreadable action log, an unsupported log version, an unset variable the log needs, a role missing from `--config`, or a `--strict` replay that could not find an element. |

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
