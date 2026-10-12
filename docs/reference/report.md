# Report

`monkey run` writes everything into `report.dir` (default `./monkey-report`, relative to the config file):

```text
monkey-report/
  report.html              one self-contained page: open it in any browser, also offline
  report.json              the same data, machine-readable
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
findings: 5 (2 high, 2 medium, 1 low)
report: …/monkey-report/report.html
exit 1: findings present
```

## `report.html`

A single file with inline CSS and the screenshots embedded as images; it has no scripts and loads nothing from the
network. It shows:

- the run (base URL, seed, start time, tool version) and the number of findings per severity;
- one row per role: steps, duration, why it stopped, findings, and links to its action log, trace and video;
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

Paths are relative to the report directory. LLM usage joins the report with M2.

## Secrets

`report.json`, `report.html` and the console mask every value that came from a `${VAR}` placeholder; `actions.json`
stores the placeholder instead, so the log can be replayed. A test runs the fixture with distinct credentials and
greps every text file of the report directory for them.

**Traces and videos are not masked.** Playwright has no way to redact a trace, and it records:

- the context options, including `baseURL` and the storage state with the logged-in **session cookie**;
- every request and response with URLs, headers and cookies;
- every value the monkey typed, including test data from `${VAR}` placeholders;
- screenshots and DOM snapshots, and the video, of whatever the pages showed.

Passwords of a form login are not in them: the login runs in a separate context without trace or video. Treat
`trace.zip` and the videos like the test environment's session data, and do not publish them.
