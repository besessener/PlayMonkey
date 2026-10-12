# Architecture

```text
config  ->  auth/session  ->  loop { snapshot -> choose action (monkey | LLM) -> execute -> oracles }  ->  action log + report
                                                   ^
                                     provider interface: anthropic-foundry | openai
```

A run loads the config, opens one browser and one context per role, and then repeats: take a snapshot of the page,
pick the next action (the seeded random monkey, or the LLM when the monkey is stuck), execute it, and let the oracles
check what happened. Every action goes to an action log, every problem to a deduplicated finding, and the run ends
with a report.

## Modules

| Path | Responsibility | Status |
| --- | --- | --- |
| `src/cli/` | Argument parsing (`node:util` `parseArgs`), subcommands, exit codes | done |
| `src/config/` | JSON Schema, `${VAR}` resolution, validation, defaults, secret masking | done |
| `src/auth/` | Browser launch, one context per role, login, `stayOnDomain`, trace and video | done |
| `src/snapshot/` | Page snapshot with element refs, snapshot hash, LLM serializer | done |
| `src/monkey/` | Seeded random action generator, executor and run loop | done |
| `src/run.ts` | Plans the runs (roles × seeds) and runs them, `parallel` at a time: session, monkey or replay, oracles, action log, artifacts | done |
| `src/oracles/` | Detect and deduplicate findings, screenshots | done |
| `src/replay/` | Action log writer and reader, durable locator parser, `monkey replay` | done |
| `src/report/` | `report.json` and the self-contained `report.html` | done |
| `src/llm/` | Provider interface, `anthropic-foundry` and `openai` backends, prompt, preflight, stuck detection, handoff, usage | done |
| `fixtures/site/` | Local site with seeded bugs, the ground truth for end-to-end tests | done |

## Design decisions

- **Playwright library API, not the MCP server:** the tool needs control over action selection, seeding and the
  oracles.
- **The LLM is optional and occasional.** The random monkey is the default; the LLM only steps in when it is stuck,
  so runs stay cheap and an LLM outage never stops a run.
- **Findings must be reproducible.** LLM decisions are not deterministic, so every action is logged with a durable
  locator and `monkey replay` re-executes the log without an LLM.
- **One context per run:** cookies and storage never leak between roles or seeds, so runs can execute in parallel
  in one browser. The LLM budget and circuit breaker are shared by all runs.
