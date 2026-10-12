# Roadmap

The plan lives in the [epic](https://github.com/besessener/PlayMonkey/issues/1); each work item is a sub-issue
carrying its milestone in the title. Work goes in milestone order, with a review after each.

| Milestone | Scope | Status |
| --- | --- | --- |
| **M1** Monkey without LLM | Scaffold, config, fixture site, auth, snapshot and refs, random monkey, oracles, action log and replay, report | done (v0.1) |
| **M2** LLM backend `anthropic-foundry` | Provider interface, preflight, stuck detection and fallback, token accounting | done |
| **M3** Backend `openai` and hardening | OpenAI-compatible backend; cookie banners, dialogs, iframes, popups, file inputs, downloads | planned |
| **M4** Comfort | Parallel runs per role and seed, documentation, CI example | planned |

## Definition of done for v0.1 (M1 complete)

- `monkey run fixture.json` against the fixture site finds the seeded JS error, the broken link and the HTTP 500,
  and reports each exactly once.
- The same seed yields the same monkey action sequence.
- `monkey replay` reproduces the findings.
- No secret appears in logs, report or trace metadata.

## Out of scope

Visual regression, performance benchmarking, a GUI, test-code generation.
