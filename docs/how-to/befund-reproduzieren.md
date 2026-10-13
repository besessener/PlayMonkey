# Reproduce a finding

Every finding comes with what is needed to see it again: the seed, the action log, a trace, and the steps written
out in the report.

## 1. Read the steps in the report

Open `report.html`. Each finding lists the last `findings.lastActions` actions before it (default 10) with durable
locators such as `getByRole('button', { name: 'Send' })`, the page and a screenshot. Often that is enough to repeat it
by hand. Raise `findings.lastActions` when the cause lies further back.

## 2. Watch the trace

```sh
npx playwright show-trace monkey-report/user/trace.zip
```

The [trace viewer](https://playwright.dev/docs/trace-viewer) shows every action with the DOM before and after, the
console, the network and screenshots. Jump to the step the finding names (`first at step N`). The video next to the
trace shows the same without the detail. With `seeds`, the files are in `<role>/<seed>/`.

## 3. Replay the action log

```sh
npx monkey replay monkey-report/user/actions.json --config config.json
```

Replay executes the recorded actions again in a fresh, logged-in context, without randomness and without an LLM, runs
the oracles and prints for each recorded finding whether it was `reproduced`. Exit code `1` means at least one
recurred. Add `--watch` to [watch it](lauf-beobachten.md), `--strict` to stop at the first element that is gone. How it
works and what drift means: [replay](../explanation/replay.md).

## 4. Or run the seed again

The seed is printed at the start of every run and stored in `report.json` and `actions.json`. With the same seed, the
same config and an unchanged site, the random monkey takes the same steps:

```json
{ "baseUrl": "https://test.example.org", "seed": 1234567 }
```

A changed site, or LLM decisions, send a seeded run elsewhere; the action log does not depend on either, which is why
replay is the reliable way.

## Findings from CI

Download the `monkey-report` artifact of the CI run (see [run in CI](in-ci-ausfuehren.md)), unpack it, and replay its
`actions.json` against the same test environment, with the same environment variables set.
