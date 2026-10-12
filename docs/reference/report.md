# Report

`monkey run` writes everything into `report.dir` (default `./monkey-report`, relative to the config file):

```text
monkey-report/
  report.html              one self-contained page: open it in any browser, also offline
  report.json              the same data, machine-readable
  llm-debug.jsonl          only with llm.debugLog: every LLM prompt and response, sanitized
  <role>/
    actions.json           the action log, see action-log.md
    trace.zip              Playwright trace: npx playwright show-trace <role>/trace.zip
    video/*.webm           video of each page of the role
    screenshots/step-NNNN.png
                           one screenshot per step that produced a new finding
```

At the end of a run the console says how many findings of which severity there are, where the report is, and why
the exit code is what it is:

```text
llm: 14 calls (1 failed), 81234 in / 912 out tokens (60110 cached), 5 handoffs, 12 actions, 1 fallback, p95 2310 ms
findings: 5 (2 high, 2 medium, 1 low)
report: …/monkey-report/report.html
exit 1: findings present
```

## `report.html`

A single file with inline CSS and the screenshots embedded as images; it has no scripts and loads nothing from the
network. It shows:

- the run (base URL, seed, start time, tool version) and the number of findings per severity;
- one row per role: steps, duration, why it stopped, findings, and links to its action log, trace and video;
- with `llm`: an **LLM usage** table (total and per role) and notes when the LLM was disabled or its budget ran out;
- the findings, by severity and then by how often they occurred. Each has its oracle, message, page, role and step,
  the **steps to reproduce** (the last `findings.lastActions` actions, written out with their durable locators), the
  screenshot and the details the oracle recorded.

Everything shown comes from the page under test or the config, so all of it is HTML-escaped. Links to traces and
videos are relative, so keep the directory together when you move it.

## `report.json`

| Field | Meaning |
| --- | --- |
| `version` | Format version, currently `1`. |
| `tool` | `{ "name": "playmonkey", "version": … }`. |
| `startedAt`, `finishedAt` | ISO timestamps of the run. |
| `seed` | The seed of the run. |
| `config` | The config with defaults applied and every secret value masked as `***`. |
| `roles[]` | Per role: `role`, `steps`, `durationMs`, `stopReason` (`maxSteps`, `maxMinutes`, `aborted`, `error`), `error`, `states`, `failedActions`, `findings` (count), `blockedNavigations`, and the paths `actionLog`, `trace`, `videos`. A role that could not log in has only `role`, `error`, `findings: 0` and empty `videos`. |
| `findings[]` | Every finding as described in [oracles and findings](../explanation/oracles.md#finding-model), sorted like the HTML, with `screenshot` as a path. |
| `counts` | Findings per severity: `critical`, `high`, `medium`, `low`. |
| `llm` | Only with `llm` in the config; see below. |

Paths are relative to the report directory.

### `llm`

| Field | Meaning |
| --- | --- |
| `provider`, `deployment` | The backend and deployment. |
| `status` | `active`, or `disabled` when the preflight failed with `llm.required: false` (`disabledReason` says why). |
| `preflight` | `{ ok, latencyMs }` or `{ ok: false, error }`. Its tokens are not counted below. |
| `budget` | `maxCalls`, `maxTokens` as configured, and `exhausted: { role, step, reason }` once the budget ran out; the rest of the run was a pure monkey. |
| `pricing` | Echo of `llm.pricing`, when set. |
| `total`, `roles[]` | Usage of the whole run and per role (`roles[].role`), see below. |

Each usage entry has `calls`, `failedCalls`, `errors` (failed calls by kind, e.g. `{ "rateLimited": 2 }`),
`inputTokens`, `outputTokens`, `cachedTokens` (cache reads), `cacheWriteTokens`, `retries` (requests the SDK
repeated; not counted as calls), `handoffs` (by trigger, see [the LLM](../explanation/llm.md#when-the-monkey-hands-over)),
`actions` (LLM-chosen actions executed), `fallbacks` (steps where the monkey acted because the LLM failed, by
error kind), `breakerTrips`, `avgLatencyMs`, `p95LatencyMs` and, with `llm.pricing`, `estimatedCost`: an
**estimate** in the pricing's currency, not a bill.

## `llm-debug.jsonl`

Written only with `llm.debugLog: true`; otherwise no prompt or response is stored anywhere. One JSON object per LLM
call: `time`, `role`, `step`, `attempt`, `prompt` (the user message), `input` (its parts), `result` or `error`, and
`response` (the provider's raw response). Prompts never contain secret values (see
[placeholders](../explanation/llm.md#secrets-and-placeholders)); every string is masked once more before writing.

## Secrets

`report.json`, `report.html`, `llm-debug.jsonl` and the console mask every value that came from a `${VAR}` placeholder; `actions.json`
stores the placeholder instead, so the log can be replayed. A test runs the fixture with distinct credentials and
greps every text file of the report directory for them.

**Traces and videos are not masked.** Playwright has no way to redact a trace, and it records:

- the context options, including `baseURL` and the storage state with the logged-in **session cookie**;
- every request and response with URLs, headers and cookies;
- every value the monkey typed, including test data from `${VAR}` placeholders;
- screenshots and DOM snapshots, and the video, of whatever the pages showed.

Passwords of a form login are not in them: the login runs in a separate context without trace or video. Treat
`trace.zip` and the videos like the test environment's session data, and do not publish them.
