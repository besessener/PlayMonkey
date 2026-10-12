# Development setup

From a clone to build, tests and lint passing locally, the same checks CI runs.

## Requirements

- Node.js 22.18 or newer. The tests import the TypeScript sources directly through Node's type stripping, which is on
  by default from 22.18. The built CLI itself runs on any Node.js 22.
- A Playwright Chromium for the browser tests.

## Steps

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run lint
```

`npm test` builds first, then runs `node --test` on `test/**/*.test.ts`. That includes browser tests against the
fixture site. `npm run lint` runs `biome ci` and typechecks `src` and `test`.

`npx playwright install chromium` also installs the ffmpeg build Playwright uses to record video. If you cannot
install browsers (for example in a sandbox) but have another Chromium, point the tests at it:

```sh
CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm test
```

Video recording still needs the matching ffmpeg; without it the video test fails.

## Git hooks

The hooks in `.pre-commit-config.yaml` (gitleaks, zizmor, file hygiene) run with [prek](https://github.com/j178/prek) or
`pre-commit`:

```sh
prek install           # run them on every commit
prek run --all-files   # run them once over the whole tree
```

## Before you push

```sh
npm run format         # apply Biome formatting and safe fixes
npm run check          # lint, types, dead code, tests with coverage thresholds
prek run --all-files
```

CI (`.github/workflows/ci.yml`) runs the same: a hygiene job with gitleaks over the whole history and the hooks, and
a build-test job that installs Chromium with `--with-deps`, then build, lint, Knip and the tests with coverage on
Node 22. Every gate and threshold is listed in [quality gates](../reference/quality.md); every script in
[commands](../reference/commands.md).
