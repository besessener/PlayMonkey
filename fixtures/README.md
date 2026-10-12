# Fixture site

A small local site with deliberately seeded bugs, used by the end-to-end tests. It is the **ground truth** for the
oracles: a run against it must report every bug below and nothing else.

```sh
npm run fixture             # prints the URL, the login and the env vars for configs/fixture.json
PORT=8080 npm run fixture   # fixed port
```

In tests:

```ts
import { startFixture } from "../fixtures/site/server.ts";

const site = await startFixture(); // free port on 127.0.0.1
// ... site.url ...
await site.close();
```

Test login: `monkey` / `banana-split` (`FIXTURE_CREDENTIALS`). `configs/fixture.json` reads the URL and credentials
from `FIXTURE_URL`, `FIXTURE_USER` and `FIXTURE_PASS`.

## Pages

| Path             | Content                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `/`              | Links to every page, plus the broken link.                                              |
| `/login`         | Username/password form. Correct login sets a session cookie and redirects to `/account`. Wrong login re-renders the form with a message (status 200). |
| `/account`       | Requires a session (otherwise 303 to `/login`). Has a "Log out" button.                 |
| `/form`          | Contact form: text, email, select, checkbox, textarea. `novalidate`, so the browser never blocks a submit. An invalid email re-renders the form with a message (status 200). |
| `/js-error`      | Button that throws when clicked.                                                        |
| `/console-error` | Logs `console.error` on load.                                                           |
| `/overflow`      | 1600px wide banner.                                                                     |
| `/clean`         | Control page with a search box and a toggle button. Must produce no findings.           |

Every page links back to `/`. Echoed input is HTML-escaped, so script-like monkey input cannot create unseeded bugs.
A `data:` favicon prevents the browser's automatic `/favicon.ico` request (which would be a 404).

## Seeded bugs (expected findings)

Each bug must be reported **exactly once** (deduplicated), with these oracles:

| # | Bug                   | Click path                                         | Oracle      | Severity | Dedup key                       |
| - | --------------------- | -------------------------------------------------- | ----------- | -------- | ------------------------------- |
| 1 | Broken internal link  | Home → "Broken link"                               | `http4xx`   | low/medium | `GET /missing-page 404`       |
| 2 | Uncaught JS exception | Home → "JS error" → "Do not press"                 | `pageerror` | high     | `Seeded bug: click handler crashed` + first stack frame |
| 3 | HTTP 500 on submit    | Home → "Contact form" → "Send" with an empty name, or any field longer than 1000 characters | `http5xx` | high | `POST /form 500` |
| 4 | Console error         | Home → "Console error"                             | `console`   | medium   | `Seeded bug: console error on load` |
| 5 | Horizontal overflow   | Home → "Overflow" (any viewport narrower than ~1650px) | `overflow` | low  | `/overflow` + viewport bucket   |

The broken link may additionally surface as an `errorPage` signal (404 page titled "Not found"); oracle dedup
decides whether that is the same finding (see the oracle issue).

`/clean`, `/login`, `/account` and a valid `/form` submission are controls and must yield **no** findings.
`test/fixture-site.test.ts` walks every click path above in a real browser and checks the control pages stay silent.

## Adding a page

Add a route to `createRoutes` in `site/pages.ts` (set `link` to list it on the home page), add its seeded bug to
the table above, and extend `test/fixture-site.test.ts` with its click path.
