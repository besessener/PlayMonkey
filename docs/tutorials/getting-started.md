# Getting started

This walks you from a fresh clone to a first `monkey run` against the local fixture site. You need
Node.js 22.18 or newer (the fixture site runs TypeScript directly) and git. No LLM is needed.

## 1. Install

```sh
git clone https://github.com/besessener/PlayMonkey.git
cd PlayMonkey
npm ci                             # also builds the CLI
npx playwright install chromium    # on Linux: --with-deps installs the system libraries too
npx monkey --help
```

## 2. Start the fixture site

The repository ships a small site with deliberately seeded bugs. In a second terminal:

```sh
npm run fixture
```

It prints its URL, the test login and the variables the example config needs, for example:

```text
Fixture site running at http://127.0.0.1:41234
Login: monkey / banana-split
For fixtures/configs/fixture.json:
  export FIXTURE_URL=http://127.0.0.1:41234 FIXTURE_USER=monkey FIXTURE_PASS=banana-split
```

## 3. Run the monkey

Copy the `export` line into your first terminal, then:

```sh
npx monkey run fixtures/configs/fixture.json
```

The monkey logs in as the role `user`, takes 300 random steps (the config's `limits.maxSteps`) and prints a summary
with the five seeded bugs, each reported once however often the monkey ran into it:

```text
seed: 42
[user] starting
[user] 300 steps in 37.1s, 47 states, 0 failed actions, stopped: maxSteps, 5 findings
[user]   F1 medium console: Seeded bug: console error on load (step 1, 14×)
[user]   F2 high pageerror: Error: Seeded bug: click handler crashed (step 18, 12×)
[user]   F3 medium http4xx: GET /missing-page responded 404 Not Found (step 20, 10×)
[user]   F4 low overflow: horizontal overflow on /overflow: div makes the page 1664px wide in a 1280px viewport (step 26, 12×)
[user]   F5 high http5xx: POST /form responded 500 Internal Server Error (step 99, 2×)
[user] actions: …/fixtures/configs/monkey-report/user/actions.json
[user] trace: …/fixtures/configs/monkey-report/user/trace.zip
findings: 5 (2 high, 2 medium, 1 low)
report: …/fixtures/configs/monkey-report/report.html
exit 1: findings present
```

Open `fixtures/configs/monkey-report/report.html` in a browser: each finding with its steps to reproduce, a
screenshot and links to the trace and video. The same data is in `report.json`; see the
[report reference](../reference/report.md).

Watch what it did with `npx playwright show-trace fixtures/configs/monkey-report/user/trace.zip`, or look at the video
next to it. Run it again: with the same seed it takes the same steps.

## 4. Replay the run

Every action went to `actions.json`. Replay it, with the config for the login:

```sh
npx monkey replay fixtures/configs/monkey-report/user/actions.json --config fixtures/configs/fixture.json
```

It repeats the 300 steps without choosing anything and checks which findings recur:

```text
[user] replaying 300 actions
[user] 300 steps in 29.3s, 47 states, 0 failed actions, stopped: end, 5 findings
…
reproduced      F1 medium console: Seeded bug: console error on load
reproduced      F2 high pageerror: Error: Seeded bug: click handler crashed
reproduced      F3 medium http4xx: GET /missing-page responded 404 Not Found
reproduced      F4 low overflow: horizontal overflow on /overflow: div makes the page 1664px wide in a 1280px viewport
reproduced      F5 high http5xx: POST /form responded 500 Internal Server Error
reproduced: 5 of 5
```

The log stores the URL and the login as `${FIXTURE_URL}` and friends, so it also replays after you restart the
fixture on another port. See [replay](../explanation/replay.md).

## 5. See a config error

Unset a variable and run again:

```sh
unset FIXTURE_PASS
npx monkey run fixtures/configs/fixture.json
echo $?
```

The error names the config path and the variable (`auth[0].fields.password: environment variable FIXTURE_PASS is
not set`), never a value, and the exit code is `2`.

## Next

- Write a config for your own test environment: [configuration reference](../reference/configuration.md).
- Set up roles and logins: [configure login](../how-to/configure-login.md).
- Let an LLM help when the monkey is stuck: [configure the LLM](../how-to/configure-llm.md).
- More roles and seeds at once: [run in parallel](../how-to/run-in-parallel.md).
- Run it on every pull request: [run in CI](../how-to/run-in-ci.md).
