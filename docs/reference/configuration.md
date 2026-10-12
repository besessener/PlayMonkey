# Configuration

`monkey run <config.json>` reads one JSON file. The schema, with the same descriptions and defaults, is
`src/config/schema.ts`; `test/docs.test.ts` fails when a key there is missing from this page.

## Example

```json
{
  "baseUrl": "https://test.example.org",
  "seed": 42,
  "limits": { "maxSteps": 500, "maxMinutes": 20 },
  "browser": { "engine": "chromium", "viewport": [1280, 800], "headless": true },
  "stayOnDomain": true,
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    },
    { "name": "user", "storageState": "./states/user.json" }
  ],
  "testData": { "email": "monkey@test.local" },
  "llm": {
    "provider": "anthropic-foundry",
    "baseUrl": "https://<resource>.services.ai.azure.com/anthropic",
    "deployment": "<deployment-name>",
    "apiKey": "${FOUNDRY_API_KEY}",
    "maxCalls": 200,
    "pricing": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3 }
  },
  "oracles": { "overflow": false },
  "findings": { "lastActions": 10, "ignoreStatus": [401], "ignore": [{ "oracle": "console", "message": "^\\[analytics\\]" }] },
  "report": { "dir": "./monkey-report" }
}
```

## Keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | – | Optional JSON Schema reference for editors; ignored. |
| `baseUrl` | string, required | – | Absolute `http(s)` URL of the site under test. |
| `seed` | integer 0 … 4294967295 | random, printed | Seed of the random monkey. Set it to reproduce a run. |
| `limits.maxSteps` | integer ≥ 1 | `500` | Maximum number of actions per role. |
| `limits.maxMinutes` | number > 0 | `20` | Maximum wall-clock minutes per role. |
| `browser.engine` | `chromium` \| `firefox` \| `webkit` | `chromium` | Playwright browser engine. |
| `browser.viewport` | `[width, height]`, integers ≥ 1 | `[1280, 800]` | Viewport in CSS pixels. |
| `browser.headless` | boolean | `true` | Run the browser without a window. |
| `stayOnDomain` | boolean | `true` | Do not follow navigations to other origins than `baseUrl`'s. |
| `auth` | array | `[]` (one anonymous role) | Roles to run as; see below. |
| `auth[].name` | string, required | – | Unique role name. |
| `auth[].loginUrl` | string | – | Login page path, relative to `baseUrl`. Required with `fields`. |
| `auth[].fields` | object of strings | – | Login form fields to fill: key → value. |
| `auth[].submit` | string | – | Selector of the login submit button. Required with `fields`. |
| `auth[].storageState` | string | – | Playwright storage state file, relative to the config file. |
| `testData` | object of strings | `{}` | Valid values the monkey may use when filling fields (keys are free). |
| `llm` | object | absent | LLM used when the monkey is stuck. Absent means pure random monkey. |
| `llm.provider` | `anthropic-foundry` \| `openai` | – | Backend. Required in `llm`. |
| `llm.baseUrl` | string | – | Endpoint base URL: up to `/anthropic` for `anthropic-foundry`, the full OpenAI-compatible base URL (e.g. `…/openai/v1`) for `openai`. Required in `llm`. |
| `llm.deployment` | string | – | Deployment name, used as the model. Required in `llm`. |
| `llm.apiKey` | string | – | API key; use a `${VAR}` placeholder. Required in `llm`. |
| `llm.required` | boolean | `true` | A failed [preflight](../how-to/configure-llm.md#troubleshooting) exits with code `2`; `false` warns and runs as pure random monkey. |
| `llm.timeoutMs` | integer ≥ 1000 | `60000` | Timeout of one LLM request in milliseconds. |
| `llm.maxRetries` | integer 0 … 10 | `2` | Retries of one request after a rate limit (429), server or connection error, with exponential backoff. Other errors are not retried. |
| `llm.maxCalls` | integer ≥ 0 | unlimited | Budget: LLM calls per run, over all roles. When spent, the run continues as pure monkey and the report says so. |
| `llm.maxTokens` | integer ≥ 0 | unlimited | Budget: tokens per run, over all roles (input, output, cache reads and writes). |
| `llm.debugLog` | boolean | `false` | Write every prompt and response, sanitized, to `llm-debug.jsonl` in the report directory. Off: no prompt content is written anywhere. |
| `llm.historyActions` | integer ≥ 0 | `10` | Number of recent actions shown to the LLM. |
| `llm.snapshotChars` | integer ≥ 500 | `8000` | Character budget of the page snapshot in the prompt (roughly four characters per token). |
| `llm.handoff.noStateChange` | integer ≥ 1 | `5` | Hand over after this many steps in a row without any change of the page. |
| `llm.handoff.noProgress` | integer ≥ 1 | `25` | Hand over after this many steps in a row without a new (URL, snapshot hash) state. |
| `llm.handoff.failedActions` | integer ≥ 1 | `5` | Hand over after this many failed monkey actions in a row. |
| `llm.handoff.invalidForm` | integer ≥ 1 | `3` | Hand over after this many form submissions in a row that end on validation errors. |
| `llm.handoff.blockingUi` | boolean | `true` | Hand over when a dialog or a cookie or consent banner is open. |
| `llm.handoff.loginWall` | boolean | `true` | Hand over when a role that logged in arrives on a login page (expired session). |
| `llm.handoff.maxDecisions` | integer ≥ 1 | `3` | Consecutive LLM decisions per handoff; then the monkey takes over again. |
| `llm.handoff.cooldownSteps` | integer ≥ 0 | `5` | Monkey steps after a handoff before the next one can start. |
| `llm.breaker.failures` | integer ≥ 1 | `3` | Failed LLM decisions in a row that open the circuit breaker. |
| `llm.breaker.pauseSteps` | integer ≥ 1 | `20` | Steps without LLM while the breaker is open. |
| `llm.pricing` | object | absent | Prices per million tokens for an **estimated** cost in the report. There are no built-in prices. |
| `llm.pricing.inputPerMTok` | number ≥ 0 | – | Price per million input tokens. Required in `pricing`. |
| `llm.pricing.outputPerMTok` | number ≥ 0 | – | Price per million output tokens (thinking included). Required in `pricing`. |
| `llm.pricing.cacheReadPerMTok` | number ≥ 0 | `inputPerMTok` | Price per million tokens read from the prompt cache. |
| `llm.pricing.cacheWritePerMTok` | number ≥ 0 | `inputPerMTok` | Price per million tokens written to the prompt cache. |
| `llm.options.maxOutputTokens` | integer ≥ 16 | `4096` | Output token limit of a request (`max_tokens`, `max_output_tokens` or `max_completion_tokens`). Thinking and reasoning tokens count against it. |
| `llm.options.thinking` | `adaptive` \| `disabled` \| `between_tools` | model default | `anthropic-foundry` only. Thinking mode sent to the model. Absent sends nothing; which values a model accepts differs, see [configure the LLM](../how-to/configure-llm.md#thinking-and-effort). |
| `llm.options.effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | model default | Effort level sent to the model: Anthropic's effort, OpenAI's reasoning effort. |
| `llm.options.api` | `responses` \| `chat` | `responses` | `openai` only. The Responses API, or Chat Completions for models that only offer that; see [configure the LLM](../how-to/configure-llm.md#openai-models-and-other-openai-compatible-endpoints). |
| `oracles.pageerror` | boolean | `true` | Report uncaught exceptions. |
| `oracles.console` | boolean | `true` | Report `console.error` messages. |
| `oracles.http5xx` | boolean | `true` | Report responses with status ≥ 500. |
| `oracles.http4xx` | boolean | `true` | Report responses with status 400 … 499. |
| `oracles.crash` | boolean | `true` | Report page or browser crashes. |
| `oracles.hang` | boolean | `true` | Report actions or navigations that exceed their timeout. |
| `oracles.errorPage` | boolean | `true` | Report navigations that land on an error page. |
| `oracles.overflow` | boolean | `true` | Report horizontal overflow. |
| `oracles.download` | boolean | `true` | Report downloads that fail (e.g. the connection drops). |
| `findings.lastActions` | integer ≥ 0 | `10` | Number of actions before a finding that it records, for reproduction. |
| `findings.ignoreStatus` | array of integers 400 … 599 | `[]` | HTTP statuses that are never findings, e.g. `[401, 403]`. |
| `findings.ignore` | array | `[]` | Rules that drop known noise; see [ignore rules](../explanation/oracles.md#ignore-rules). |
| `findings.ignore[].oracle` | oracle name | any | Only signals of this oracle. |
| `findings.ignore[].url` | regular expression | – | Matched against the request URL (HTTP findings) or the page URL. |
| `findings.ignore[].message` | regular expression | – | Matched against the finding message. Each rule needs `url` or `message`. |
| `report.dir` | string | `./monkey-report` | Report output directory, relative to the config file. |
| `report.keepDownloads` | boolean | `false` | Keep the files the site downloaded, in `<role>/downloads/` of the report directory. Off: they are measured (name, size) and deleted when the role ends. |
| `monkey.actionTimeoutMs` | integer ≥ 100 | `5000` | Timeout of one action in milliseconds; a slower action fails and the run continues. Also how long a step waits for dialogs, uploads and downloads to finish. |
| `monkey.maxTabs` | integer ≥ 1 | `5` | Open tabs per role. When popups open more, the oldest ones the monkey left behind are closed (never the first tab or the current one). |
| `monkey.weights.click` | number ≥ 0 | `10` | Relative weight of clicking links, buttons and other clickable elements. |
| `monkey.weights.dblclick` | number ≥ 0 | `0.5` | Relative weight of double-clicking a clickable element. |
| `monkey.weights.rightclick` | number ≥ 0 | `0.5` | Relative weight of right-clicking a clickable element (context menus). |
| `monkey.weights.hover` | number ≥ 0 | `1` | Relative weight of moving the mouse over a clickable element (hover menus, tooltips). |
| `monkey.weights.longPress` | number ≥ 0 | `0.3` | Relative weight of pressing and holding a clickable element; only in viewports narrower than 1024 px. |
| `monkey.weights.drag` | number ≥ 0 | `0.3` | Relative weight of dragging a clickable element onto another element (best effort). |
| `monkey.weights.fill` | number ≥ 0 | `6` | Relative weight of typing into text fields. |
| `monkey.weights.select` | number ≥ 0 | `3` | Relative weight of choosing a dropdown option. |
| `monkey.weights.check` | number ≥ 0 | `3` | Relative weight of toggling checkboxes, radios and switches. |
| `monkey.weights.press` | number ≥ 0 | `1` | Relative weight of pressing a key (Tab, Enter, Escape, arrows). |
| `monkey.weights.scroll` | number ≥ 0 | `1` | Relative weight of scrolling. |
| `monkey.weights.back` | number ≥ 0 | `1.5` | Relative weight of going back in the history. |
| `monkey.weights.navigate` | number ≥ 0 | `1` | Relative weight of opening a URL seen earlier in the run. |
| `monkey.weights.setViewport` | number ≥ 0 | `0.2` | Relative weight of resizing the viewport. |
| `monkey.weights.switchTab` | number ≥ 0 | `1` | Relative weight of switching to another open tab. |

How the LLM is used is explained in [the LLM](../explanation/llm.md); setting up a backend in
[configure the LLM](../how-to/configure-llm.md). What each oracle reports is explained in [oracles and findings](../explanation/oracles.md).

## Rules

- **Auth roles:** each uses either `fields` with `loginUrl` and `submit`, or `storageState`, never both.
- **Unknown keys are rejected**, not warned about: a typo such as `maxStep` would otherwise silently fall back to a
  default. Only `testData` and `auth[].fields` take arbitrary keys.
- **`null` is rejected**; omit a key to get its default.
- **Ignore rules** need `url` or `message`, and both must be valid JavaScript regular expressions; to switch an
  oracle off entirely, use `oracles.<name>: false`.
- **Relative paths** (`auth[].storageState`, `report.dir`) are resolved against the directory of the config file.
- **Errors** are all listed at once, each with its path (e.g. `auth[0].fields.password`); the exit code is `2`.

## Secrets: `${VAR}`

`${VAR}` in any string value is replaced with the environment variable `VAR`, also inside longer strings
(`"https://${HOST}/app"`). Names match `[A-Za-z_][A-Za-z0-9_]*`. Substituted values are not expanded again and there
is no escape syntax. An unset variable is an error naming the config path and the variable; an empty one is used as
empty.

Every substituted value is masked as `***` in console output, error messages and reports. Secrets come only from
the environment, never from files.
