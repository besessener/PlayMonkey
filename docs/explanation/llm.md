# The LLM

The seeded random monkey is good at hammering a page and bad at getting past obstacles: a consent banner, a dialog,
a form that wants a valid IBAN, an expired session. The LLM is only asked then, for a few decisions, so runs stay
cheap and fast, and an LLM outage never stops a run. Without `llm` in the config the loop is exactly the M1 monkey.

## A step with an LLM

```text
snapshot -> stuck? --no--> monkey chooses
               |
              yes -> LLM chooses (up to maxDecisions in a row, then cooldown)
                       | invalid answer: ask once more
                       | still failing: monkey chooses this step
               v
execute -> oracles -> action log (source "monkey" or "llm")
```

The LLM sees a [serialized snapshot](snapshot.md#serializing-for-the-llm) within `llm.snapshotChars`, the last
`llm.historyActions` actions with their outcomes, the findings so far, why it was called, the role, and the
placeholders it may use. It answers with exactly one tool call; each action is one tool (`click`, `dblclick`, `hover`,
`fill`, `select`, `check`, `uncheck`, `press`, `scroll`, `back`, `navigate`) plus `done` to give control back
early. Native dialogs and file choosers are answered automatically, also during the LLM's steps; the prompt says so.

Nothing it returns is trusted. The tool input is validated against the tool's JSON schema, element tools must name a
ref of the current snapshot, and `navigate` must stay on the site when `stayOnDomain` is on. A violation counts as an
invalid answer.

## When the monkey hands over

The stuck detection runs before every monkey decision; the first trigger that holds starts a handoff.
Thresholds are under `llm.handoff`.

| Trigger | Fires when |
| --- | --- |
| `blockingUi` | A dialog (`role=dialog` or `alertdialog`, including an open `<dialog>`) is open, or the page mentions cookies or consent and has a button such as "Accept" or "Reject". |
| `loginWall` | A role that logged in arrives on its `loginUrl`, or on a page with a password field and a "Log in" or "Sign in" button: the session probably expired. Fires once per arrival. |
| `invalidForm` | `invalidForm` submissions in a row (a button click or Enter on a page with a form) end on the same path with validation text such as "required" or "please enter a valid …". |
| `failedActions` | The monkey's last `failedActions` actions all failed (elements never became actionable, timeouts). |
| `noStateChange` | The page did not change at all for `noStateChange` steps. |
| `noProgress` | No new (URL, snapshot hash) state was found for `noProgress` steps. |

A handoff gives the LLM up to `maxDecisions` decisions in a row; `done` ends it earlier. Then the monkey has at least
`cooldownSteps` steps before the next handoff, and the counters start afresh.

## Fallback and circuit breaker

- **Bad answer** (text instead of a tool call, an invalid tool call, a refusal, an answer cut off at
  `maxOutputTokens`): asked once more with the same input, then the monkey chooses this step.
- **Transport and HTTP errors:** the SDK retries rate limits (429), server errors and connection problems with
  exponential backoff (`llm.maxRetries`); other errors, such as 400 or 401, fail at once. Then the monkey chooses.
- **Outage:** after `llm.breaker.failures` failed decisions in a row the LLM is paused for `llm.breaker.pauseSteps`
  steps, then tried again.
- **Budget:** once `llm.maxCalls` or `llm.maxTokens` is reached, the rest of the run (all remaining roles) is a pure
  monkey.

Every handoff, fallback, breaker trip and the budget's end are logged on the console and counted in the
[report](../reference/report.md#llm).

## Secrets and placeholders

Secrets never enter a prompt:

- Login fields and test data are offered as placeholders, `{{<role>.<field>}}` (e.g. `{{admin.password}}`) and
  `{{testData.<key>}}`, never as values. The model writes the placeholder; PlayMonkey substitutes the value after the
  model returned, right before typing.
- Any value from a `${VAR}` placeholder that shows up in the page, a URL or the history is replaced by
  `{{env.VAR}}` before it is sent; the model may use that placeholder too.
- The action log stores what was typed with the `${VAR}` placeholder as usual, so [replay](replay.md) works without
  the LLM.

Prompts and responses are not stored unless `llm.debugLog` is on, and then masked once more.

## Prompt caching

The system prompt and the tool definitions are identical for every call of a run and come first; the snapshot and
history change and come last. Backends with prompt caching mark the stable part as cacheable (Anthropic:
`cache_control` on the system prompt, which caches the tools with it; OpenAI caches long identical prefixes
automatically). Cache reads show up as `cachedTokens`. Very
short prompts may be below a model's minimum cacheable length and are then simply not cached.

## Adding a backend

A backend implements `LlmProvider` from `src/llm/provider.ts`:

```ts
interface LlmProvider {
  readonly name: string;
  preflight(): Promise<PreflightResult>; // one probe that must come back as a `ping` tool call; never throws
  decide(input: DecideInput): Promise<DecideResult>; // throws LlmError on any failure
}
```

- Declare the shared `ACTION_TOOLS` (and `PING_TOOL` for the preflight) from `src/llm/tools.ts` in the provider's
  tool format, send `SYSTEM_PROMPT` and `buildUserMessage(input)` from `src/llm/prompt.ts`, stable parts first.
- Do not force a tool choice: some models reject it. The prompt asks for exactly one tool call.
- Turn the first tool call into a decision with `parseToolCall(name, input, input.refs)`, which validates it.
- Map failures to an `LlmError` with a kind (`auth`, `notFound`, `rateLimited`, `invalid`, …; see
  `LlmErrorKind`) and keep the usage of failed calls; the preflight hints and the report are keyed by kind.
- Report `usage` (input, output, cache read and write tokens) and how many requests were retried.
- Add the name to `LLM_PROVIDERS` in `src/config/schema.ts` and to `createProvider` in `src/llm/factory.ts`.

`test/helpers/fake-provider.ts` is a scripted provider for tests; `test/foundry.test.ts` and `test/openai.test.ts`
show how to test a backend with its HTTP layer mocked. Add the new backend to `test/provider-conformance.test.ts`:
it runs the same conversations (valid and invalid tool calls, text only, retries, errors, preflight) against every
backend.

## Backends

| Provider | SDK | API |
| --- | --- | --- |
| `anthropic-foundry` | `@anthropic-ai/foundry-sdk` | Anthropic Messages API on Foundry (`…/anthropic/v1/messages`) |
| `openai` | `openai` | Responses API (default) or Chat Completions on any OpenAI-compatible base URL |

Both map their SDK's typed errors through `src/llm/sdk-errors.ts`, so retries, error kinds and the preflight hints
behave the same.
