# Oracles and findings

After every step of the [monkey](monkey.md), the oracles decide whether something went wrong. Each problem becomes
a **finding**, deduplicated so a bug hit fifty times is reported once, with enough context to reproduce it. The code
lives in `src/oracles/`.

## The oracles

| Oracle | Signal | Severity |
| --- | --- | --- |
| `pageerror` | Uncaught exception in a page (`page.on('pageerror')`). | high |
| `console` | `console.error` message (`page.on('console')`, type `error`). | medium |
| `http5xx` | Response with status 500 … 599 (`page.on('response')`), any resource type. | high |
| `http4xx` | Response with status 400 … 499, except `findings.ignoreStatus`. | medium for the page itself, low for subresources and API calls |
| `crash` | The page's renderer crashed (`page.on('crash')`). | critical |
| `hang` | A navigation or page load exceeded `monkey.actionTimeoutMs`, or the page stopped answering a trivial script. | high |
| `errorPage` | A navigation landed on an error page (see below). | medium |
| `overflow` | Horizontal overflow: the document's `scrollWidth` is larger than its `clientWidth`. | low |
| `download` | A download the site started failed, e.g. the connection dropped mid-file (`download.failure()`). | medium |

Each one can be switched off with `oracles.<name>: false` in the [config](../reference/configuration.md).

The event oracles (`pageerror`, `console`, `http*`, `crash`) listen on every page of the role's browser context,
including tabs and popups the site opens and the iframes inside them. `download` looks at the downloads of each step
(see [the monkey](monkey.md#pages-that-ask-for-something)). The state oracles (`hang`, `errorPage`, `overflow`) look at the page the monkey is on
after each step, with one script evaluation per step.

### What is not a finding

- **A failed action.** An element that is covered, gone or never becomes clickable times out, but that is the
  monkey's problem, not the site's. Only timeouts while waiting for a navigation or a page load count as `hang`.
- **Chromium's echo of a failed response** (`Failed to load resource: the server responded with a status of 404`) in
  the console. The response itself is the HTTP oracles' finding; the echo would report it twice.
- **An error page whose status the HTTP oracles report.** A 404 page is one `http4xx` finding, not also an
  `errorPage`. `errorPage` covers what the HTTP oracles cannot see: soft error pages served with status 200 whose
  title or main heading says "Not found", "Something went wrong", "Internal Server Error", "Error 500" and the like;
  and failed pages whose HTTP oracle is switched off.
- **Off-domain navigations** blocked by `stayOnDomain`: they are logged as session events, see
  [sessions](sessions.md).

## Finding model

| Field | Meaning |
| --- | --- |
| `id` | `F1`, `F2`, … in order of discovery within a role. |
| `oracle`, `severity` | As in the table above. |
| `key` | Dedup key, see below. |
| `message` | One line, e.g. `GET /missing-page responded 404 Not Found`. |
| `url` | The page the monkey was on when the finding was detected. |
| `step` | The step after which it was detected; signals that arrive while a step runs belong to that step. |
| `role` | The role that found it. |
| `occurrences` | How often the same key was seen. |
| `details` | Oracle-specific: method, request URL, status and resource type for HTTP; the stack for `pageerror`; the console location; widths and the culprit element for `overflow`. |
| `lastActions` | The last `findings.lastActions` actions (default 10) up to and including `step`, each with its durable locator: the way to the bug. |
| `screenshotPath` | A screenshot taken right after detection, in `<report.dir>/<role>/screenshots/`. Absent for crashed or hung pages. |

Everything in a finding except the screenshot path goes through [secret masking](ground-rules.md), because pages can
echo what was typed into them.

## Deduplication

Every signal gets a key. A key that was seen before raises the first finding's `occurrences`; the finding keeps the
context (step, screenshot, last actions) of its **first** occurrence, which is usually the shortest way to it.

| Oracle | Key |
| --- | --- |
| `pageerror` | Normalized message + first stack frame (with line and column: the same message from two places is two bugs). |
| `console` | Normalized message. |
| `http4xx`, `http5xx` | Method + normalized URL + status. |
| `overflow` | Normalized page URL + the culprit element (the outermost element sticking out on the right, e.g. `div.banner`). |
| `errorPage` | Normalized page URL + status. |
| `hang` | Kind (`navigation` or `unresponsive`) + normalized URL. |
| `crash` | Normalized page URL. |
| `download` | Normalized download URL. |

**Normalization** removes what changes between occurrences of the same bug:

- URLs lose query and fragment; numeric path segments become `:n`, uuids, hex ids and long tokens `:id`
  (`/orders/4711/items/9?x=1` → `/orders/:n/items/:n`). The site's own origin is dropped, so keys stay the same when
  the test environment moves to another host or port, between a run and its replay for example.
- Messages get the same treatment for URLs inside them; other numbers become `#`, ids `:id`, and whitespace is
  collapsed.

An overflow is keyed by its culprit rather than by viewport size: a too-wide element overflows phone, tablet and
laptop viewports alike and is one bug. Overflows caused by different elements, at different breakpoints, stay
separate. Staying on an overflowing page counts once per visit, not once per step.

## Ignore rules

Known noise, such as a third-party widget that logs errors, is dropped with `findings.ignore`:

```json
"findings": {
  "ignoreStatus": [401],
  "ignore": [
    { "oracle": "console", "message": "^\\[analytics\\]" },
    { "url": "^https://widgets\\.example\\.com/" }
  ]
}
```

A rule matches when every part it sets matches: `oracle` exactly, `url` and `message` as JavaScript regular
expressions (case-sensitive) against the request URL (HTTP findings) or page URL (all others) and the finding
message. `findings.ignoreStatus` lists HTTP statuses that are never findings; a 401 from an API the site expects to
fail is a typical one.

## Crashes

A crashed page throws on every call. The monkey closes it and continues in another tab, or in a fresh page on
`baseUrl`, so one crash does not end the run.

## Adding an oracle

Oracles live in `src/oracles/oracles.ts`; each produces signals through `#add(oracle, signal)`, which applies the
ignore rules and deduplicates by key.

1. Add the name to `ORACLES` in `src/config/values.ts`. That makes `oracles.<name>` a config key (default on);
   document it in [configuration](../reference/configuration.md), which `test/docs.test.ts` enforces.
2. Detect the problem in the `Oracles` class: an **event oracle** registers a listener in `#watch(page)`, which runs
   for every page of the context, popups included; a **state oracle** checks the page after each step in
   `#inspect(page, navigated)`; something recorded in the step's events belongs in `check`. Return early when
   `this.#config.oracles.<name>` is off.
3. Call `this.#add("<name>", { severity, key, message, url, details })`. Build the **key** from what identifies the
   bug and stays the same across occurrences, runs and replay: use `normalizeUrl` and `normalizeMessage` from
   `src/oracles/keys.ts`, and never the step, a timestamp or the port. Keep the message short; put the rest in
   `details`.
4. Add a page with the bug to the [fixture site](../how-to/use-the-fixture-site.md) and a test in
   `test/oracles.test.ts` that the oracle reports it exactly once, and does not fire on a clean page.

Everything else follows: the finding gets an id, the last actions and a screenshot, goes into the action log for
replay, into both reports, and is aggregated across [parallel runs](../how-to/run-in-parallel.md).
