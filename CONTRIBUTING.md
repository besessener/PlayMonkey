# Contributing

Thanks for helping. PlayMonkey is a small TypeScript CLI on Playwright; the [documentation](docs/README.md) explains
how it works.

## Set up

Node.js 22.18 or newer:

```sh
npm ci                            # installs and builds (prepare)
npx playwright install chromium
```

Details, also for sandboxes without a Playwright browser: [development setup](docs/tutorials/development-setup.md).

## Work

| Task | Command |
| --- | --- |
| Build `src/` to `dist/` | `npm run build` |
| Run all tests (builds first) | `npm test` |
| One test file | `node --test test/report.test.ts` |
| Lint and typecheck | `npm run lint` |
| Format and safe fixes | `npm run format` |
| Fixture site with seeded bugs | `npm run fixture` |
| Try the CLI | `npx monkey run fixtures/configs/fixture.json` |

Tests use `node:test` and run the TypeScript sources directly. End-to-end tests start the
[fixture site](fixtures/README.md) themselves; a new kind of bug gets a fixture page first, then the code, then a
test that it is reported exactly once.

## Before you open a pull request

```sh
npm run format
npm run lint
npm test
```

- Keep changes focused; one topic per pull request, its milestone in the title when it belongs to one
  ([roadmap](docs/explanation/roadmap.md)).
- Update the docs with the code. A new config key goes into `src/config/schema.ts` **and**
  [configuration](docs/reference/configuration.md); `test/docs.test.ts` fails otherwise. It also checks relative
  links and anchors, that every sample config parses, and that the [CI example](docs/how-to/run-in-ci.md) matches
  `.github/workflows/monkey.yml`.
- Never let a secret reach output: values from `${VAR}` placeholders are masked everywhere, see the
  [ground rules](docs/explanation/ground-rules.md).

CI runs build, lint and tests (`ci.yml`) and the CI example against the fixture site (`monkey.yml`).

## Releasing

1. Add a section `## X.Y.Z – <date>` to [CHANGELOG.md](CHANGELOG.md) and set the version:
   `npm version X.Y.Z --no-git-tag-version`. Merge that through a pull request.
2. Tag the merge commit on `main` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

`.github/workflows/release.yml` then checks that the tag matches `package.json` and publishes a GitHub release with
the changelog section as notes. `test/docs.test.ts` fails when the changelog has no section for the package version.

## Extending

- A new LLM backend: [adding a backend](docs/explanation/llm.md#adding-a-backend).
- A new oracle: [adding an oracle](docs/explanation/oracles.md#adding-an-oracle).
