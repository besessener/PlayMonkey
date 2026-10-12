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

## Before you push

```sh
npm run format   # apply Biome formatting and safe fixes
npm run lint
npm test
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, installs Chromium with `--with-deps`, then build, lint and test on
Node 22. See [commands](../reference/commands.md) for every script.
