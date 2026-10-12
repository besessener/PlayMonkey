# Commands

## `monkey`

```text
monkey run <config.json>      Explore the site described by the config and report findings.
monkey replay <actions.json>  Re-execute a recorded action log and check which findings recur.
monkey --help | -h
monkey --version | -v
```

| Command | Today |
| --- | --- |
| `run` | Validates the config, prints the seed, then runs the random monkey with the [oracles](../explanation/oracles.md) for every role. Prints a summary per role, one line per finding, the trace path and the total number of findings; screenshots go to `<report.dir>/<role>/screenshots/`. The full report (`report.json`, `report.html`) follows with #10. |
| `replay` | Not implemented yet. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings (also `--help`, `--version`). |
| `1` | Findings present. |
| `2` | Tool or config error: bad usage, unknown command or option, invalid config, a role that failed to log in (the other roles still run), a run that lost its browser. |

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
