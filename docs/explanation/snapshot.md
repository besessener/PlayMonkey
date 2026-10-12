# Page snapshots

The random monkey and the LLM see the page the same way: as a list of actionable elements, each with a short-lived
**ref** such as `e8`, taken from Playwright's accessibility snapshot.

## Where the refs come from

Playwright (since 1.59) takes an "AI mode" aria snapshot that assigns a ref to every element
(`page.ariaSnapshotJSON({ mode: "ai" })`, the structured form since 1.63) and resolves refs back to elements with
`page.getByRef(ref)`. PlayMonkey builds on that instead of keeping its own element registry:

- **Elements:** nodes with an interactive role (link, button, textbox, checkbox, combobox, …) plus anything the page
  marks clickable (`cursor: pointer`). Each carries role, accessible name, link target, placeholder, combobox
  options, checked and expanded state, whether it is enabled, whether it is in the viewport (from its bounding box)
  and whether it is inside an iframe.
- **Open shadow DOM** is part of the snapshot. **Same-origin iframes** (including `srcdoc` and `about:blank`) are
  entered; their elements resolve like any other. **Cross-origin iframes** are counted, not entered: acting inside
  them would act on another origin.
- **Text:** static text and the names of headings and other non-actionable nodes, in document order.

## Refs are short-lived

A ref belongs to the latest aria snapshot of the page. A new snapshot keeps the refs of elements that are still there,
but a navigation renumbers them, and **any** other aria snapshot of the page (including `locator.ariaSnapshot()`)
replaces the set. `resolve(page, ref)` therefore checks that the ref matches exactly one element and throws
`StaleRefError` at once; Playwright itself would wait for the element until its timeout.

Because refs do not survive page loads, the action log stores a durable locator next to each ref:
`durableLocator(page, ref)` asks Playwright for the locator `codegen` would write, for example
`getByRole('button', { name: 'Send' })`.

## Snapshot hash

The hash identifies a page state for stuck detection and the action log. It is a SHA-256 over the snapshot tree with
refs, bounding boxes, focus and cursor removed and whitespace normalised. So it stays the same for an unchanged page,
across reloads and runs, and changes when content or element state changes (a section opens, a checkbox is ticked).
It does not include the URL; the monkey tracks states as (URL, hash) pairs.

## Serializing for the LLM

`serializeSnapshot(snapshot, { maxChars })` renders the snapshot as plain lines (`e8 textbox "Name"`) within a
character budget (default 8000, roughly 2000 tokens). Elements in the viewport come first, then the rest in document
order; names are shortened, the page text gets at most a quarter of the budget when elements need the rest, and the
output always says what was left out (`[312 more elements omitted to fit the budget]`).
