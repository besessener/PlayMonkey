# Use the fixture site

The fixture site in `fixtures/site/` is a small local site with seeded bugs. Its pages and the findings they must
produce are listed in [fixtures/README.md](../../fixtures/README.md).

## Start it by hand

```sh
npm run fixture             # free port; prints the URL, login and env vars
PORT=8080 npm run fixture   # fixed port
```

Point a config at it with `fixtures/configs/fixture.json`, which reads `FIXTURE_URL`, `FIXTURE_USER` and
`FIXTURE_PASS`.

## Start it from a test

```ts
import { startFixture } from "../fixtures/site/server.ts";

const site = await startFixture(); // free port on 127.0.0.1, own sessions
try {
  // ... site.url ...
} finally {
  await site.close();
}
```

## Add a page

1. Add a route to `createRoutes` in `fixtures/site/pages.ts`; set `link` to list it on the home page.
2. Escape every echoed input with `escapeHtml`, so monkey input cannot create bugs that are not seeded.
3. Add the page and any seeded bug, with its click path and expected finding, to `fixtures/README.md`.
4. Extend `test/fixture-site.test.ts` with the click path.
