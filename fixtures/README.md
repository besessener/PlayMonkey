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
| 1 | Broken internal link  | Home → "Broken link"                               | `http4xx`   | medium   | `GET /missing-page 404`         |
| 2 | Uncaught JS exception | Home → "JS error" → "Do not press"                 | `pageerror` | high     | `Seeded bug: click handler crashed` + first stack frame |
| 3 | HTTP 500 on submit    | Home → "Contact form" → "Send" with an empty name, or any field longer than 1000 characters | `http5xx` | high | `POST /form 500` |
| 4 | Console error         | Home → "Console error"                             | `console`   | medium   | `Seeded bug: console error on load` |
| 5 | Horizontal overflow   | Home → "Overflow" (any viewport narrower than ~1650px) | `overflow` | low  | `/overflow` + culprit `div`     |

The 404 and the 500 pages are not also reported as `errorPage` (the HTTP oracles already cover their status), and
Chromium's console echo of them ("Failed to load resource …") is not a `console` finding; see
[oracles and findings](../docs/explanation/oracles.md). The overflow is keyed by its culprit element, not the
viewport, so resizing does not split it into several findings.

`/clean`, `/login`, `/account` and a valid `/form` submission are controls and must yield **no** findings.
`test/fixture-site.test.ts` walks every click path above in a real browser and checks the control pages stay silent;
`test/oracles.test.ts` runs `configs/fixture.json` end to end and expects exactly these five findings.

## The lab

`/lab` holds pages for the hard parts of real sites. The home page does **not** link there, so a run from `/` never
reaches it and the five bugs above stay exactly five; start a run at `/lab` to include it (`/lab` links to `/`).

| Path | Content |
| --- | --- |
| `/lab` | Links to every lab page and back to the main site. |
| `/lab/consent` | A full-screen cookie banner (`role="dialog"`, "Accept all", "Reject all") over the page until answered; the answer is kept in a cookie. |
| `/lab/dialogs` | Buttons that open `alert`, `confirm` and `prompt`; a checkbox that adds a `beforeunload` warning. |
| `/lab/alert-on-load` | An `alert` while the page loads: it blocks the load event until answered. |
| `/lab/frames` | A same-origin iframe, a `srcdoc` iframe and an iframe from another origin (`localhost` instead of `127.0.0.1`). |
| `/lab/popups` | A `target="_blank"` link, `window.open`, a popup that closes itself, and a `target="_blank"` link to an external site. |
| `/lab/upload` | A file input, a multiple one, and a button that opens a hidden file input; lists the chosen files. |
| `/lab/download` | A working download (`report.csv`, 29 bytes) and a broken one. |
| `/lab/widgets` | A hover menu, double-click to edit, a context menu, drag and drop, press and hold. |

Seeded bugs in the lab:

| # | Bug | Click path | Oracle | Severity | Dedup key |
| - | --- | --- | --- | --- | --- |
| L1 | Uncaught exception inside an iframe | Lab → "Frames" → "Crash in frame" (in the inner frame) | `pageerror` | high | `Seeded bug: frame handler crashed` + first stack frame |
| L2 | Uncaught exception while a popup loads | Lab → "Popups" → "Details in a new tab" or "Open a window" | `pageerror` | high | `Seeded bug: popup failed to initialise` + first stack frame |
| L3 | Download breaks off mid-file | Lab → "Download" → "Download the export" | `download` | medium | `/lab/files/export.zip` |

`test/lab.test.ts` walks every lab page with scripted actions through the real run loop; `test/chaos.test.ts` lets
20 seeds loose on the lab and the main site and checks that no run crashes, hangs or exceeds its time limit.

## Adding a page

Add a route to `createRoutes` in `site/pages.ts` (set `link` to list it on the home page), add its seeded bug to
the table above, and extend `test/fixture-site.test.ts` with its click path.
