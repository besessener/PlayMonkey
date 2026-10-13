# Replay

Every finding must be reproducible. The random monkey is reproducible by its seed as long as the site renders the
same, but LLM decisions are not, and a changed site sends a seeded run elsewhere. So `monkey run` records every
executed action in an [action log](../reference/aktionsprotokoll.md), and `monkey replay` executes that log again:

```sh
monkey replay monkey-report/user/actions.json --config config.json
```

## What replay does

1. Reads the log, checks its `version`, and resolves its `${VAR}` placeholders from the environment.
2. Opens a fresh browser context for the recorded role, logged in as the config describes. Without `--config`,
   only anonymous logs replay; browser and oracle settings are then the defaults. `baseUrl`, viewport and seed
   always come from the log.
3. Executes the actions in order through the same loop as `monkey run`, with the same page handling: a page that
   left the site's origin is sent back to `baseUrl`, a crashed page is replaced.
4. Runs the same [oracles](orakel.md) and compares their findings with the recorded ones by dedup key.

No LLM is involved, and replay needs neither an `llm` config nor network access to one: LLM decisions are in the log
as plain actions.

## Finding elements again

Refs only exist for one snapshot, so element actions are found by their **durable locator**, such as
`getByRole('button', { name: 'Send' })` or `locator('iframe').contentFrame().getByRole('link', { name: 'Home' })`.
Replay parses that text back into a Playwright locator. It accepts only Playwright's locator methods with literal
arguments (`getByRole`, `getByText`, `getByLabel`, `locator`, `contentFrame`, `nth`, …) and never evaluates the
text, so a log cannot run code.

A `drag` also finds its drop target by `toLocator`. Native dialogs and file choosers get the answers recorded in the
step's `events` (accepted or dismissed, the prompt text, the uploaded file names), so a replay takes the same path
through `confirm` dialogs and uploads as the recording.

Each element gets `monkey.actionTimeoutMs` to appear. When it does not, the site has **drifted** since the recording:
replay logs `step N skipped: element not found: …` and continues with the next action. With `--strict` it stops
there instead and exits `2`.

## Result

```text
reproduced      F1 medium console: Seeded bug: console error on load
not reproduced  F2 high http5xx: POST /form responded 500 Internal Server Error
new             F3 low overflow: horizontal overflow on /overflow: div makes the page 1664px wide in a 1280px viewport (step 26)
reproduced: 1 of 2
```

Each recorded finding is `reproduced` or `not reproduced`; findings the recording did not have are listed as `new`.
The exit code is `1` when at least one recorded finding reproduced, `0` when none did, and `2` on errors (unreadable
log, unsupported version, missing variable, failed login, `--strict` drift). Replay writes its trace, video and
screenshots to `replay/` next to the log.
