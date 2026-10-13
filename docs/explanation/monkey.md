# The random monkey

The monkey is the default source of actions. Each step it takes a [snapshot](snapshot.md), picks an action with a
seeded random generator, executes it and hands the result on. The same seed and the same site give the same run.

## Determinism

- **Generator:** sfc32 seeded through splitmix32 (`src/monkey/random.ts`), 32-bit integer arithmetic only, so the
  sequence is the same on every platform. `Math.random` is never used. A test pins the first values.
- **Seed:** `seed` from the config, or a random one that `monkey run` prints so you can put it in the config.
- **Inputs to every choice** are the snapshot (elements in document order), what the run has explored so far and the
  generator. As long as the site renders the same, the same seed yields the same sequence of actions, values and
  durable locators; a test runs the fixture twice and compares.
- **Answers to the page** (native dialogs, file choosers) come from a second generator seeded from the same seed, so
  they never shift the monkey's own sequence; see [pages that ask for something](#pages-that-ask-for-something).
- **With an LLM** the run stays seeded, but each step the LLM takes is one the generator does not, so the sequence
  differs from a run without `llm` from the first handoff on. Until then it is identical; a test checks this. See
  [the LLM](llm.md).

## Choosing an action

1. **Action type** by weight (`monkey.weights`), among the types possible on the current page: `click` (links,
   buttons, anything clickable), `dblclick`, `rightclick` and `hover` (on the same elements: in-place editing,
   context menus, hover menus), `longPress` (press and hold; only in viewports narrower than 1024 px), `drag` (an
   element onto another one, best effort), `fill` (text fields), `select` (dropdowns), `check` (checkboxes, radios,
   switches; a checked one is unchecked), `press` (Tab, Shift+Tab, Enter, Escape, arrows, Space: keyboard-only
   navigation), `scroll`, `back`, `navigate` (to a URL seen earlier in the run), `setViewport` (phone, tablet,
   laptop, desktop sizes) and `switchTab` (only with several tabs). A weight of 0 disables a type.
2. **Element** within that type, preferring what is new: an element's weight drops with every time it was used in
   the same state (URL and snapshot hash), and links to a URL the run has not visited yet count three times.
   Disabled elements are skipped; with `stayOnDomain`, links to other origins are not candidates.
3. **Blocking UI first:** while a dialog is open, the elements inside it count ten times; while a cookie or consent
   banner shows, so do its answer buttons ("Accept", "Reject", …). Such overlays usually cover the page, so clicks
   elsewhere would only time out. The run never stalls on one: a covered element fails after
   `monkey.actionTimeoutMs`, and with an LLM the open dialog is also a [handoff](llm.md#when-the-monkey-hands-over)
   trigger.

## Values for text fields

About half the time the monkey types a valid value: test data whose key appears in the field's name or placeholder
(`email` matches "E-Mail address"), otherwise a plain value such as `Monkey`. The other half it types something
nasty: empty, whitespace, 10 000 characters, Unicode with emoji and right-to-left text, special characters,
HTML and script-like strings, SQL-like strings, numbers out of range, an impossible date.

## Executing and settling

Each action runs with `monkey.actionTimeoutMs` (default 5 s). Element actions resolve the ref first and fail fast
when it is stale. When the main document changed, the executor waits for its `load` event before the next snapshot.

**A failed action is not a finding:** an element that vanished, is covered or does not respond is recorded with the
error and the run continues. Problems of the site are the [oracles'](orakel.md) job; a timeout while waiting
for a navigation or page load is the exception, it is a `hang`.

## Pages that ask for something

Every page of the role's context, popups included, is watched (`src/monkey/events.ts`):

- **Native dialogs** (`alert`, `confirm`, `prompt`, `beforeunload`) are accepted or dismissed at random, at once; a
  prompt gets a plain or nasty value. An open dialog would block the page, so none is ever left open, not even one
  that a page shows while loading.
- **File choosers**, opened by clicking a file input or a button that opens one, get a generated file: a small text
  file, a PNG, an empty file, 1 MiB, a wrong extension (`invoice.pdf.exe`), text named `.png`, and a Unicode file
  name; sometimes two when the input takes several. No file comes from the disk.
- **Downloads** are saved to `<report.dir>/<role>/downloads/`, measured, and deleted when the role ends unless
  `report.keepDownloads` is on. A download that fails is a `download` [finding](orakel.md).

Each step waits up to `monkey.actionTimeoutMs` for these to finish and records them with the step (`events` in the
[action log](../reference/aktionsprotokoll.md)); replay gives the same answers again.

## Tabs and popups

When an action opens a popup or a new tab, the monkey continues there, as a user would; `switchTab` goes back.
Oracles watch every tab. With `stayOnDomain`, a popup to another site is blocked and closed, and the monkey goes on
in the first tab. More than `monkey.maxTabs` open tabs (default 5) are not kept: the oldest ones the monkey left
behind are closed, never the first tab or the current one.

## Frames

[Same-origin iframes](snapshot.md) are part of the snapshot, so the monkey acts inside them like anywhere else, and
the oracles see their errors. Cross-origin iframes are counted, not entered: Playwright could act in them, but their
content belongs to another site.

## Limits

The loop stops at `limits.maxSteps`, at `limits.maxMinutes` (checked before every step) or when interrupted
(Ctrl+C finishes the current step, then writes the trace). With `stayOnDomain`, a page that ends up on another origin
or a blank page is sent back to `baseUrl`. A crashed page is closed and the run continues in another tab or a fresh
page; the `crash` oracle reports it.

## Coverage on the fixture site

With seeds 1, 2 and 3, the monkey reaches every page of the fixture and triggers all five seeded bugs (JS error,
console error, broken link, HTTP 500, overflow) well within the default 500 steps, typically in 100 to 150. The test
`test/monkey.test.ts` checks this for those three seeds.
