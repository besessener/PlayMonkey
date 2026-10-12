# Configure login

Each entry in `auth` is a role. PlayMonkey runs every role in its own browser context; see
[sessions and login](../explanation/sessions.md) for how that works.

## Log in through the form

```json
{
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    }
  ]
}
```

- `loginUrl` is relative to `baseUrl`.
- Each key in `fields` finds one input: a CSS selector if it looks like one (`input[name=user]`, `#pass`), otherwise
  the `name` attribute, then the `id`, then the visible label. It must match exactly one element.
- `submit` is a selector for the button that sends the form; it must match exactly one element.

## Reuse a saved session

When the login cannot be scripted (single sign-on, a one-time code), log in once by hand and save Playwright's
storage state, for example with a short script:

```ts
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://test.example.org/login");
await page.pause(); // log in in the browser window, then resume
await context.storageState({ path: "states/user.json" });
await browser.close();
```

Then reference the file. The path is relative to the config file; `states/*.json` is in `.gitignore` because the
file contains session cookies.

```json
{ "auth": [{ "name": "user", "storageState": "./states/user.json" }] }
```

## Several roles

List them all; names must be unique. Each role runs separately, with its own cookies:

```json
{
  "auth": [
    { "name": "admin", "loginUrl": "/login", "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" }, "submit": "button[type=submit]" },
    { "name": "user", "storageState": "./states/user.json" }
  ]
}
```

Without `auth`, PlayMonkey runs one anonymous role. To run the roles at the same time instead of one after the
other, set `parallel`; see [run in parallel](run-in-parallel.md).

## Keep secrets out of the file

Write `${VAR}` wherever a secret goes and set the variable in the environment (in CI, from the secret store).
Substituted values are masked as `***` in all output. An unset variable stops the run with exit code 2 and names the
config path and the variable.

## When the login fails

The error names the role and the reason, never a value:

| Message | Check |
| --- | --- |
| `login field "x" not found on /login` | The key matches no element (or several). Use a CSS selector. |
| `submit selector "…" must match exactly one element` | Make the selector more specific. |
| `login did not succeed: still on /login after submitting` | Credentials, field keys, or a captcha. |
| `cannot read storageState file … (ENOENT)` | Path, relative to the config file. |
| `… is not a Playwright storage state` | The file must be JSON with a `cookies` array. |
