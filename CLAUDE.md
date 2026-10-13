# CLAUDE.md

Standing instructions for Claude Code and any other AI assistant working in this repository. Read this file before
writing anything.

## What this project is

**PlayMonkey** (`monkey`) is a command line tool that drives a real browser with Playwright against a website in a
throwaway test environment, clicks, types and submits with seeded randomness, and reports what breaks with the steps
to reproduce it. An LLM steps in only when the random monkey is stuck. Full docs: [docs/README.md](docs/README.md)
(English, Diátaxis).

- **Entry point:** `src/cli/main.ts`; modules and responsibilities in
  [architektur.md](docs/explanation/architektur.md).
- **Runtime:** Node.js 22, TypeScript run through Node's type stripping, few dependencies
  ([werkzeuge.md](docs/explanation/werkzeuge.md)).
- **Ground truth:** the [fixture site](fixtures/README.md) with seeded bugs.
- **Siblings:** [flakipype](https://github.com/besessener/flakipype) and [Archivist](https://github.com/besessener/Archivist)
  share these rules, the docs layout and the `site/` layout; a change to a shared rule or layout is mirrored there.

## Read before you touch

| Area | Read first |
| --- | --- |
| Modules, run pipeline | [architektur.md](docs/explanation/architektur.md) |
| Secrets, stop conditions, roles | [grundregeln.md](docs/explanation/grundregeln.md) |
| LLM backends, handoff, fallback | [llm.md](docs/explanation/llm.md) |
| Findings and oracles | [orakel.md](docs/explanation/orakel.md) |
| Action log, replay | [replay.md](docs/explanation/replay.md), [aktionsprotokoll.md](docs/reference/aktionsprotokoll.md) |
| Config keys | [konfiguration.md](docs/reference/konfiguration.md) |
| Tests, CI, quality gates | [qualitaetssicherung.md](docs/reference/qualitaetssicherung.md), [befehle.md](docs/reference/befehle.md) |

## Hard rules

Settled decisions and safety rules. If a task seems to need one reversed, stop and say so; never work around it
quietly. Reasoning lives in `docs/explanation/`, not here.

- **Secrets never reach output.** Values come only from `${VAR}` environment placeholders and are masked as `***` in
  console output, errors, reports and action logs; prompts carry `{{placeholders}}`, never values.
- **The LLM is optional.** A run without an LLM, or with one that is down, still works. LLM SDKs are imported only in
  `src/llm/`, behind the provider interface (enforced by `biome.json`).
- **Findings are reproducible.** The same seed gives the same actions; every action is logged with a durable locator
  so `monkey replay` reproduces a finding without an LLM.
- **Runs always end.** Never remove a limit or make one unlimited by default.
- **Neutral and generic.** No organisation-specific names, branding or URLs in code or defaults.
- Never lower a coverage threshold (`test:coverage` in `package.json`) or auto-ratchet one. An unreachable threshold
  is a design problem: redesign, or raise it with the user.
- No `biome-ignore`, `@ts-expect-error` or `{ skip }` without understanding the failure first; the reason goes on the
  same line. No `.only`, no test gaming.
- Tests never call a real model or an external site; they use the fixture site and fake providers. The opt-in
  Foundry test costs money: only when asked.
- Never write real API keys or tokens anywhere, not even as an example.
- Never commit to `main`, skip hooks (`--no-verify`), force-push over others' commits, or rewrite history on a branch
  you don't own.
- Never modify `.github/workflows/**`, repository secrets, branch protection, or the security hooks in
  `.pre-commit-config.yaml` (gitleaks, zizmor, detect-private-key) unless the user explicitly asks.

## How to work here

- **Ask, don't bury.** A decision that is the user's (a design choice, a rule that seems to need reversing, scope
  beyond the request) is asked with the question tool as soon as it comes up, with options and a recommendation. A
  note in a PR description or summary does not count as asking. Without that tool, put the question first in your
  reply and wait for the answer.
- **Smallest necessary change.** Preserve behaviour unless changing it is what was asked. Boy-scout fixes stay inside
  the function or file you are already editing.
- **When principles collide:** correctness and security, then KISS/YAGNI, then clean code, then DRY. No abstraction
  for a requirement nobody has; extract on the third occurrence.
- **Small units:** cognitive complexity at most 15, at most 4 parameters (else a named options object), functions
  under 50 lines, files under 350 lines (tests under 600); Biome enforces it. Hard-to-reach coverage or a function
  over a limit means extract the logic, not suppress the rule.
- **Comments:** one line, only for a non-obvious constraint, workaround, invariant or external behaviour — never to
  narrate code or record a decision (that goes in the commit or PR).
- **Fail fast; measure, don't assume.** Errors carry a cause and a next step and are never swallowed. Performance and
  coverage are numbers a tool prints.
- **Language:** English everywhere — CLI output, reports, prompts, docs, identifiers, logs.
- **Tests:** assert behaviour, not implementation. A new kind of bug gets a fixture page first, then the code, then a
  test that it is reported exactly once.
- **Docs sync:** a change to behaviour, configuration or a design decision updates the matching `docs/` file in the
  same change. A new config key goes into `src/config/schema.ts` (`llm.*` keys into `src/config/llm-schema.ts`, defaults
  into `src/config/defaults.ts`) and [konfiguration.md](docs/reference/konfiguration.md); `test/docs.test.ts` fails
  otherwise. The root `README.md` stays short.

## Development commands

```sh
npm ci                            # install and build
npx playwright install chromium   # the browser
npm run check                     # every local quality gate
```

All commands: [befehle.md](docs/reference/befehle.md).

## Definition of done

Not done — no "done", no ready PR, no reported success — until every one of these is green, from the repo root:

```sh
npm run check          # lint, types, dead code, tests with coverage thresholds
prek run --all-files   # gitleaks, zizmor, file hygiene
```

A partial run is a status update, not a stopping point. If a gate blocks finishing, say so — never relax the gate.
