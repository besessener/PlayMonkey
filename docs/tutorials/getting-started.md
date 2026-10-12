# Getting started

This walks you from a fresh clone to a first `monkey run` against the local fixture site. You need
Node.js 22 (22.18 or newer if you also want to run the tests) and git.

> PlayMonkey is in early development: `monkey run` logs in and explores, but does not detect findings yet; the
> oracles, action log and report arrive next, see the [roadmap](../explanation/roadmap.md).

## 1. Install

```sh
git clone https://github.com/besessener/PlayMonkey.git
cd PlayMonkey
npm ci
npx playwright install chromium
npm run build
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

The monkey logs in as the role `user`, takes 300 random steps (the config's `limits.maxSteps`) and prints a summary:

```text
seed: 42
[user] starting
[user] 300 steps in 31.0s, 47 states, 0 failed actions, stopped: maxSteps
[user] trace: …/fixtures/configs/monkey-report/user/trace.zip
findings: not detected yet (oracles are not implemented)
```

Watch what it did with `npx playwright show-trace fixtures/configs/monkey-report/user/trace.zip`, or look at the video
next to it. Run it again: with the same seed it takes the same steps.

## 4. See a config error

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
