# Changelog

All notable changes, one section per release. Versions follow [semantic versioning](https://semver.org/); before
1.0, a minor version may change the config, the report or the action log format, and says so here.

## 0.4.0 – 2026-10-12

The first tagged release: milestones M1 to M4 of the [roadmap](https://github.com/besessener/PlayMonkey/blob/main/docs/explanation/roadmap.md).

### Monkey and findings (M1)

- `monkey run`: seeded random monkey on Playwright, with stable element refs, `stayOnDomain` and limits per run.
- JSON config with schema validation, `${VAR}` secrets from the environment, masked in all output.
- Form login and saved sessions (`storageState`), several roles, one browser context each.
- Oracles: uncaught exceptions, console errors, HTTP 4xx and 5xx, crashes, hangs, error pages, horizontal
  overflow; findings deduplicated by key, with the last actions, a screenshot and ignore rules.
- Action log (`actions.json`) and `monkey replay`, which repeats a run without randomness or LLM.
- `report.json` and a self-contained `report.html`; trace and video per run; exit codes `0`, `1`, `2`.

### LLM for stuck situations (M2, M3)

- Backends `anthropic-foundry` (Claude on Microsoft Foundry) and `openai` (Responses API or Chat Completions on any
  OpenAI-compatible endpoint), behind one provider interface.
- Stuck detection, handoff, fallback to the monkey, circuit breaker, budgets (`llm.maxCalls`, `llm.maxTokens`);
  secrets reach the model only as placeholders.
- `monkey preflight` and a preflight before every run; token and estimated cost accounting in the report.
- Spectator mode: `--watch`, `--slow-mo`.

### Real-world pages (M3)

- Cookie banners and overlays, native dialogs, same-origin iframes, popups and tabs (`monkey.maxTabs`), file
  uploads, downloads with the `download` oracle.
- More actions: double-click, right-click, hover, long press, drag; action log version 2 (version 1 still read).

### Comfort (M4)

- Parallel runs: `seeds` (one run per seed and role, in `<role>/<seed>/`) and `parallel`; one combined report with
  findings aggregated across runs; shared LLM budget and circuit breaker; a failed run does not stop the others.
- CI example workflow (`.github/workflows/monkey.yml`), how-to guides for CI, parallel runs and reproducing
  findings, `CONTRIBUTING.md`.
- Install from git as a dev dependency: `npm install --save-dev github:besessener/PlayMonkey#v0.4.0`.
