# Watch a run (spectator mode)

To see what the monkey does, for keeping an eye on it or for a demo, add `--watch` (`-w`):

```sh
monkey run config.json --watch
monkey replay monkey-report/user/actions.json --config config.json --watch
```

Spectator mode:

- opens a **visible browser**, whatever `browser.headless` says;
- slows every browser operation down (Playwright's `slowMo`, default 250 ms);
- **outlines each element** in orange, labelled with its locator, for a moment before clicking, typing or selecting;
- prints **one line per step**, with who chose it (`monkey` or `llm`) and how it went:

  ```text
  [user] step 12 monkey: click getByRole('link', { name: 'Contact form' })
  [user] step 13 llm: fill getByRole('textbox', { name: 'Email' }) "monkey@test.local"
  [user] step 14 monkey: press Enter -> failed: Timeout 5000ms exceeded.
  ```

Values typed from `${VAR}` secrets show as `***`. Spectator mode changes only timing: the same seed takes the same actions as without `--watch`, the outline is removed before the
action and the next snapshot, and findings, action log, trace and report are written as usual.

## Speed

`--slow-mo <ms>` sets the delay per browser operation and implies `--watch`. The outline lasts twice as long, at
least 300 ms.

| Use | Flags |
| --- | --- |
| Live demo, easy to follow | `--slow-mo 600` |
| Default | `--watch` (250 ms) |
| Keep an eye on a long run | `--slow-mo 0`: full speed, no outline, still visible with step lines |

Lower `limits.maxSteps` for a demo: at the default speed a step takes about one to two seconds. Ctrl+C stops after the
current step and still writes the report.

A good demo is a [replay](../explanation/replay.md) of a run that found something: it shows exactly the steps to the
bug, ending on it, without randomness or LLM.

## Without a display

A visible browser needs a display. On a Linux machine or container without one, run under a virtual display:

```sh
xvfb-run -a monkey run config.json --watch
```

Without a display, `monkey run --watch` exits with code `2` and says so. To review a headless run afterwards, use the
trace (`npx playwright show-trace <role>/trace.zip`) and the video in the report directory.
