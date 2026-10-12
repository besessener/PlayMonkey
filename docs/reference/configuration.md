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
    "apiKey": "${FOUNDRY_API_KEY}"
  },
  "oracles": { "overflow": false },
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
| `llm.baseUrl` | string | – | Endpoint base URL. Required in `llm`. |
| `llm.deployment` | string | – | Deployment name, used as the model. Required in `llm`. |
| `llm.apiKey` | string | – | API key; use a `${VAR}` placeholder. Required in `llm`. |
| `oracles.pageerror` | boolean | `true` | Report uncaught exceptions. |
| `oracles.console` | boolean | `true` | Report `console.error` messages. |
| `oracles.http5xx` | boolean | `true` | Report responses with status ≥ 500. |
| `oracles.http4xx` | boolean | `true` | Report responses with status 400 … 499. |
| `oracles.crash` | boolean | `true` | Report page or browser crashes. |
| `oracles.hang` | boolean | `true` | Report actions or navigations that exceed their timeout. |
| `oracles.errorPage` | boolean | `true` | Report navigations that land on an error page. |
| `oracles.overflow` | boolean | `true` | Report horizontal overflow. |
| `report.dir` | string | `./monkey-report` | Report output directory, relative to the config file. |
| `monkey.actionTimeoutMs` | integer ≥ 100 | `5000` | Timeout of one action in milliseconds; a slower action fails and the run continues. |
| `monkey.weights.click` | number ≥ 0 | `10` | Relative weight of clicking links, buttons and other clickable elements. |
| `monkey.weights.fill` | number ≥ 0 | `6` | Relative weight of typing into text fields. |
| `monkey.weights.select` | number ≥ 0 | `3` | Relative weight of choosing a dropdown option. |
| `monkey.weights.check` | number ≥ 0 | `3` | Relative weight of toggling checkboxes, radios and switches. |
| `monkey.weights.press` | number ≥ 0 | `1` | Relative weight of pressing a key (Tab, Enter, Escape, arrows). |
| `monkey.weights.scroll` | number ≥ 0 | `1` | Relative weight of scrolling. |
| `monkey.weights.back` | number ≥ 0 | `1.5` | Relative weight of going back in the history. |
| `monkey.weights.navigate` | number ≥ 0 | `1` | Relative weight of opening a URL seen earlier in the run. |
| `monkey.weights.setViewport` | number ≥ 0 | `0.2` | Relative weight of resizing the viewport. |
| `monkey.weights.switchTab` | number ≥ 0 | `1` | Relative weight of switching to another open tab. |

`llm` and the oracles are validated now; they take effect when their milestones land (see the
[roadmap](../explanation/roadmap.md)).

## Rules

- **Auth roles:** each uses either `fields` with `loginUrl` and `submit`, or `storageState`, never both.
- **Unknown keys are rejected**, not warned about: a typo such as `maxStep` would otherwise silently fall back to a
  default. Only `testData` and `auth[].fields` take arbitrary keys.
- **`null` is rejected**; omit a key to get its default.
- **Relative paths** (`auth[].storageState`, `report.dir`) are resolved against the directory of the config file.
- **Errors** are all listed at once, each with its path (e.g. `auth[0].fields.password`); the exit code is `2`.

## Secrets: `${VAR}`

`${VAR}` in any string value is replaced with the environment variable `VAR`, also inside longer strings
(`"https://${HOST}/app"`). Names match `[A-Za-z_][A-Za-z0-9_]*`. Substituted values are not expanded again and there
is no escape syntax. An unset variable is an error naming the config path and the variable; an empty one is used as
empty.

Every substituted value is masked as `***` in console output, error messages and reports. Secrets come only from
the environment, never from files.
