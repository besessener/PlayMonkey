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
- **With an LLM** the run stays seeded, but each step the LLM takes is one the generator does not, so the sequence
  differs from a run without `llm` from the first handoff on. Until then it is identical; a test checks this. See
  [the LLM](llm.md).

## Choosing an action

1. **Action type** by weight (`monkey.weights`), among the types possible on the current page: `click` (links,
   buttons, anything clickable), `fill` (text fields), `select` (dropdowns), `check` (checkboxes, radios, switches;
   a checked one is unchecked), `press` (Tab, Shift+Tab, Enter, Escape, arrows, Space), `scroll`, `back`, `navigate`
   (to a URL seen earlier in the run), `setViewport` (phone, tablet, laptop, desktop sizes) and `switchTab` (only with
   several tabs). A weight of 0 disables a type.
2. **Element** within that type, preferring what is new: an element's weight drops with every time it was used in
   the same state (URL and snapshot hash), and links to a URL the run has not visited yet count three times.
   Disabled elements are skipped; with `stayOnDomain`, links to other origins are not candidates.

## Values for text fields

About half the time the monkey types a valid value: test data whose key appears in the field's name or placeholder
(`email` matches "E-Mail address"), otherwise a plain value such as `Monkey`. The other half it types something
nasty: empty, whitespace, 10 000 characters, Unicode with emoji and right-to-left text, special characters,
HTML and script-like strings, SQL-like strings, numbers out of range, an impossible date.

## Executing and settling

Each action runs with `monkey.actionTimeoutMs` (default 5 s). Element actions resolve the ref first and fail fast
when it is stale. When the main document changed, the executor waits for its `load` event before the next snapshot.

**A failed action is not a finding:** an element that vanished, is covered or does not respond is recorded with the
error and the run continues. Problems of the site are the [oracles'](oracles.md) job; a timeout while waiting
for a navigation or page load is the exception, it is a `hang`.

## Limits

The loop stops at `limits.maxSteps`, at `limits.maxMinutes` (checked before every step) or when interrupted
(Ctrl+C finishes the current step, then writes the trace). With `stayOnDomain`, a page that ends up on another origin
or a blank page is sent back to `baseUrl`. A crashed page is closed and the run continues in another tab or a fresh
page; the `crash` oracle reports it.

## Coverage on the fixture site

With seeds 1, 2 and 3, the monkey reaches every page of the fixture and triggers all five seeded bugs (JS error,
console error, broken link, HTTP 500, overflow) well within the default 500 steps, typically in 100 to 150. The test
`test/monkey.test.ts` checks this for those three seeds.
