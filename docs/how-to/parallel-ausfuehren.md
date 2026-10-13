# Run in parallel

Several roles, or the same role with several seeds, cover more of a site in the same wall-clock time. Each run is
one role with one seed, in its own browser context (cookies and storage never mix), in one shared browser.

```json
{
  "baseUrl": "https://test.example.org",
  "seeds": [1, 2, 3],
  "parallel": 3,
  "limits": { "maxSteps": 300, "maxMinutes": 10 },
  "auth": [
    { "name": "admin", "storageState": "./states/admin.json" },
    { "name": "user", "storageState": "./states/user.json" }
  ]
}
```

This plans 2 roles × 3 seeds = 6 runs and executes 3 at a time:

```text
seeds: 1, 2, 3
runs: 6, 3 at a time
[admin/1] starting
[admin/2] starting
[admin/3] starting
…
```

- **`seeds`** replaces `seed`: one run per seed and role. Without it, each role runs once with `seed`.
- **`parallel`** is how many runs execute at the same time (default `1`: one after the other). More runs at once
  need more CPU and memory, and put more load on the test environment; start with the number of CPU cores.
- `limits.maxSteps` and `limits.maxMinutes` apply **per run**.

## Output

With `seeds` every run writes to its own directory, and there is one combined report:

```text
monkey-report/
  report.html, report.json
  admin/1/actions.json, admin/1/trace.zip, admin/1/video/, admin/1/screenshots/
  admin/2/…
  user/3/…
```

Findings are deduplicated per run as usual, and then **aggregated across runs** by their dedup key: the report shows
each problem once, with the roles and runs that found it ("found in admin, user"), and the steps to reproduce from
the first of them. `report.json` keeps both, `findings[]` per run and `aggregated[]`; see the
[report reference](../reference/bericht.md#reportjson). Runs are listed in config order, roles first, then seeds,
whatever order they finished in.

## Determinism

Each run is as reproducible as a single one: with the LLM off, the same config and seeds take the same actions
whether the runs execute in parallel or one after the other, as long as the site behaves the same. Runs of different
roles on one test environment can still influence each other through the site's shared data (one role deletes what
another opens); that is a property of the site, not of the monkey. Replay a single run with its own
`<role>/<seed>/actions.json`.

## Failures and exit code

A run that cannot log in, or crashes, is recorded in the report and the others go on. The exit code is `2` when any
run did not complete, otherwise `1` with findings, otherwise `0`.

## With an LLM

All runs share one LLM: `llm.maxCalls` and `llm.maxTokens` are budgets for the whole `monkey run`, and calls in
flight count against `maxCalls`, so parallel runs cannot overspend it. The circuit breaker is shared too: failures in
a row count across runs, and a trip pauses the LLM in every run. The report's LLM table has one row per run
(`admin/1`, …).
