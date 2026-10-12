# Action log (`actions.json`)

`monkey run` writes one action log per role to `<report.dir>/<role>/actions.json`. It lists every executed action in
order, so `monkey replay` can repeat the run without randomness and without an LLM. The file is rewritten after
every step (to a temporary file, then renamed), so it is always complete JSON, also when a run is interrupted.

## Example

```json
{
  "version": 1,
  "seed": 42,
  "baseUrl": "${FIXTURE_URL}",
  "role": "user",
  "viewport": [1280, 800],
  "placeholders": ["CONTACT_NAME", "FIXTURE_PASS", "FIXTURE_URL", "FIXTURE_USER"],
  "actions": [
    {
      "step": 1,
      "source": "monkey",
      "type": "click",
      "ref": "e16",
      "locator": "getByRole('link', { name: 'Console error' })",
      "pageUrl": "${FIXTURE_URL}/",
      "snapshotHash": "1c62b404aedd1ffc",
      "ok": true
    },
    {
      "step": 7,
      "source": "monkey",
      "type": "fill",
      "ref": "e8",
      "value": "${CONTACT_NAME}",
      "locator": "getByRole('textbox', { name: 'Name' })",
      "pageUrl": "${FIXTURE_URL}/form",
      "snapshotHash": "6f0c3b1e9d2a4c57",
      "ok": true
    }
  ],
  "findings": [
    { "id": "F1", "oracle": "console", "severity": "medium", "key": "console|Seeded bug: console error on load", "message": "Seeded bug: console error on load", "step": 1 }
  ]
}
```

## Fields

| Field | Meaning |
| --- | --- |
| `version` | Format version, currently `1`. `monkey replay` rejects other versions with a clear message. |
| `seed`, `baseUrl`, `role`, `viewport` | The run's settings; replay uses them instead of the config's. |
| `placeholders` | Variables whose values the log stores as `${VAR}`; see below. |
| `actions[].step` | 1, 2, … in execution order. |
| `actions[].source` | `monkey`, or `llm` for an action the LLM chose. Replay executes both alike. |
| `actions[].type` and its fields | The action: `click`, `check`, `uncheck` (`ref`); `fill`, `select` (`ref`, `value`); `press` (`key`); `scroll` (`deltaY`); `back`; `navigate` (`url`); `setViewport` (`width`, `height`); `switchTab` (`index`). |
| `actions[].ref` | The element's ref in that step's snapshot. Informational: refs do not survive page loads. |
| `actions[].locator` | **Durable locator** of the element, as Playwright's `codegen` writes it. Replay finds the element by it. |
| `actions[].pageUrl`, `snapshotHash` | The state the action was chosen in. |
| `actions[].ok`, `error` | Whether the action succeeded, and why not. A failed action is still replayed. |
| `findings` | The run's findings (id, oracle, severity, dedup key, message, step), what replay compares against. |

## Secrets and placeholders

Every value that came from a `${VAR}` placeholder in the config (passwords, the base URL of the test environment,
test data) is written back as the placeholder in the log's free-text fields (`baseUrl`, `role`, `value`, `url`,
`key`, `locator`, `pageUrl`, `error`, finding messages and keys). `monkey replay` resolves them from the environment
again, and fails naming the variable when one is not set.

So the log contains no secret values, and the same log replays against another host or port when only the variable
changes. Passwords typed during the login are never logged at all: the login runs before the monkey, in its own
context.
