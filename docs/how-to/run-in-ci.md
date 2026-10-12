# Run in CI

Run the monkey on every pull request, nightly or by hand, keep the report as a build artifact, and let the
[exit code](../reference/commands.md#exit-codes) decide whether the job fails.

## Install PlayMonkey in your project

PlayMonkey is installed from git as a dev dependency; npm builds it on install (its `prepare` script):

```sh
npm install --save-dev github:besessener/PlayMonkey
npx monkey --help
```

Pin a release tag (`github:besessener/PlayMonkey#v0.4.0`, see the [changelog](../../CHANGELOG.md)) or a commit for
repeatable builds. Commit your config next to it, e.g.
`monkey.json`, with every secret as a `${VAR}` placeholder (see [configure login](configure-login.md#keep-secrets-out-of-the-file)).

## The workflow

This is `.github/workflows/monkey.yml` of the PlayMonkey repository. It runs there on every pull request against the
[fixture site](use-the-fixture-site.md), and `test/docs.test.ts` checks that this page shows it unchanged, so the
example cannot rot. Copy it to your repository and adapt the lines marked `CHANGE`:

```yaml
# Example: run PlayMonkey against a test environment in GitHub Actions.
# This copy runs in PlayMonkey's own CI against the fixture site, so the example cannot rot.
# docs/how-to/run-in-ci.md explains it; the lines marked CHANGE are the ones to adapt for your project.
name: Monkey

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  monkey:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      MONKEY_CONFIG: fixtures/configs/fixture.json # CHANGE: your config file
      MONKEY_REPORT: fixtures/configs/monkey-report # CHANGE: its report.dir, relative to the repository
      # Findings (exit 1) only warn; "true" fails the job on them. Exit 2 always fails.
      FAIL_ON_FINDINGS: "false"
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
      # Installs PlayMonkey with the other dependencies. In your project it is a devDependency:
      #   npm install --save-dev github:besessener/PlayMonkey
      # npm builds it on install.
      - name: Install dependencies
        run: npm ci
      - name: Install the browser
        run: npx playwright install --with-deps chromium
      # CHANGE: remove this step; your test environment is already running somewhere.
      - name: Start the fixture site
        run: |
          PORT=4173 npm run fixture > "$RUNNER_TEMP/fixture.log" 2>&1 &
          for _ in $(seq 30); do
            curl -sf http://127.0.0.1:4173/ > /dev/null && exit 0
            sleep 1
          done
          cat "$RUNNER_TEMP/fixture.log"
          exit 1
      - name: Run the monkey
        id: monkey
        env:
          # CHANGE: the variables your config's ${VAR} placeholders use, from the CI secret store.
          # The fixture's login is public, so it is the fallback when the secrets are not set (e.g. on forks).
          FIXTURE_URL: http://127.0.0.1:4173
          FIXTURE_USER: ${{ secrets.MONKEY_USER || 'monkey' }}
          FIXTURE_PASS: ${{ secrets.MONKEY_PASS || 'banana-split' }}
        run: |
          set +e
          npx monkey run "$MONKEY_CONFIG"
          echo "code=$?" >> "$GITHUB_OUTPUT"
      # Traces and videos hold the test environment's session cookies: keep the artifact private and short-lived.
      - name: Upload the report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: monkey-report
          path: ${{ env.MONKEY_REPORT }}
          retention-days: 7
          if-no-files-found: ignore
      - name: Check the exit code
        env:
          CODE: ${{ steps.monkey.outputs.code }}
        run: |
          case "$CODE" in
            0) echo "No findings." ;;
            1)
              if [ "$FAIL_ON_FINDINGS" = "true" ]; then
                echo "::error::PlayMonkey found problems; see the monkey-report artifact."
                exit 1
              fi
              echo "::warning::PlayMonkey found problems; see the monkey-report artifact."
              ;;
            *)
              echo "::error::PlayMonkey did not complete (exit ${CODE:-none}); see the log above."
              exit 1
              ;;
          esac
```

What it does:

1. **Installs** Node.js 22, the project's dependencies (PlayMonkey among them) and Chromium with its system
   libraries (`--with-deps`).
2. **Starts the fixture site.** Only PlayMonkey's own copy needs this; your test environment is already deployed,
   so delete the step.
3. **Runs the monkey** with the variables of the config's `${VAR}` placeholders taken from the CI secret store
   (*Settings → Secrets and variables → Actions*). Set the base URL the same way if it differs per environment, e.g.
   `"baseUrl": "${TEST_URL}"` and `TEST_URL: ${{ vars.TEST_URL }}`. `set +e` keeps the step green so the report is
   uploaded whatever happened; the exit code goes to the step output.
4. **Uploads the report directory** as the artifact `monkey-report`, also when the run failed. Download it from the
   run's summary page and open `report.html`. Traces and videos in it contain the test environment's session
   cookies (see [report: secrets](../reference/report.md#secrets)), hence the short retention.
5. **Checks the exit code:** `0` passes; `1` (findings) warns, or fails with `FAIL_ON_FINDINGS: "true"`; `2`
   (config error, failed login, failed [LLM preflight](configure-llm.md#troubleshooting), crashed run) always fails.

## Variations

- **Nightly:** add `schedule: [{ cron: "17 3 * * *" }]` under `on:`, and run longer (`limits.maxSteps`,
  `limits.maxMinutes`) than on pull requests.
- **More coverage in the same time:** several seeds and roles side by side, see [run in parallel](run-in-parallel.md).
  Keep `limits.maxMinutes` × the number of runs ÷ `parallel` under the job's `timeout-minutes`.
- **With an LLM:** add the `llm` section and its key (`FOUNDRY_API_KEY: ${{ secrets.FOUNDRY_API_KEY }}`); set a
  budget with `llm.maxCalls`. A broken endpoint fails the job with exit `2` before any browser starts, unless
  `llm.required` is `false`. See [configure the LLM](configure-llm.md).
- **Reproduce a CI finding locally:** download the artifact and replay the run's `actions.json`, see
  [reproduce a finding](reproduce-a-finding.md).
