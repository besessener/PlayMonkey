# Sessions and login

One browser is launched (`browser.engine`, `browser.headless`). Every role gets its own browser context, so cookies
and storage never leak between roles. Without `auth` entries there is one anonymous role.

## Form login

PlayMonkey opens `baseUrl + loginUrl`, fills each field, clicks `submit` and decides whether the login worked:

- **Success** when the page left the login URL (compared with where the browser actually landed, in case the login
  URL itself redirects), or, for single-page apps that log in without navigating, when a cookie changed and the
  submit button disappeared.
- **Failure** otherwise. The attempt settles as soon as the next page loads, so a wrong password fails immediately
  instead of waiting for a timeout. Following Playwright's guidance it waits for the URL and the load event, not for
  "network idle".

The login runs in a separate context without trace or video, and the run starts from the resulting storage state, so
the typed values never end up in a recording. A failed login is a tool error (exit code 2) whose message names the
role and the reason, never a value.

## Saved sessions

A `storageState` role loads a Playwright storage state file. The file is checked first (readable, JSON, has a
`cookies` array), so a mistake gives a clear message instead of a Playwright stack trace. No login request is made.

## stayOnDomain

A route on the context aborts top-level navigations to another origin and records a `blocked-navigation` info
event; this is not a finding. Subresources from other origins (CDNs, fonts, APIs) still load, because blocking them
would break most real sites.

The request is aborted as `net::ERR_ABORTED`, which leaves the page where it was. Other error codes leave the page on
the browser's error page, and answering with 204 left Playwright's click waiting for the navigation. Service workers
are blocked in this mode because they bypass request routing; routing also disables the HTTP cache.

## Trace and video

Each role records a Playwright trace with screenshots and DOM snapshots and a video of the page. Closing the session
writes `trace.zip` (open it with `npx playwright show-trace trace.zip`) and the video under `video/`. Both are
linked from the [report](../reference/bericht.md) and are not masked; see its section on secrets.
