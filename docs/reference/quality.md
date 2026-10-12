# Quality gates

Every gate below runs in CI on each pull request and push to `main`. `npm run check` runs the local ones in one go;
see [development setup](../tutorials/development-setup.md).

| Gate | Command | Checks | Workflow |
| --- | --- | --- | --- |
| Format and lint | `npm run lint` (`biome ci .`) | Formatting, Biome's recommended rules plus the stricter rules and import boundaries below | `ci.yml` |
| Types | `npm run typecheck` (part of `lint`) | `tsc` strict over `src`, `test` and `fixtures` | `ci.yml` |
| Dead code | `npm run knip` | Unused files, exports, types and dependencies ([`knip.json`](../../knip.json)) | `ci.yml` |
| Tests and coverage | `npm run test:coverage` | All tests, plus line, branch and function coverage of `src/` above the thresholds | `ci.yml` |
| Secrets | `gitleaks git` | The whole git history ([`.gitleaks.toml`](../../.gitleaks.toml)) | `ci.yml`, hygiene job |
| File hygiene and workflows | `prek run --all-files` | Merge markers, YAML/JSON syntax, files over 1 MB, private keys, trailing whitespace, final newline, line endings; zizmor audits the workflows | `ci.yml`, hygiene job |
| Code scanning | CodeQL `security-extended` | JavaScript/TypeScript and the workflows; results under Security → Code scanning | `codeql.yml`, also weekly |
| Dependency updates | Dependabot | npm packages, actions and hook revisions, weekly with a 7-day cooldown | `dependabot.yml` |

## Coverage thresholds

`npm run test:coverage` uses Node's built-in coverage (`--experimental-test-coverage`) and fails below:

| Metric | Threshold | Measured (2026-10) |
| --- | --- | --- |
| Lines | 97 % | 98.1 % |
| Branches | 88 % | 89.3 % |
| Functions | 93 % | 94.9 % |

The thresholds sit just below the measured values and are only ever raised, never lowered. The run also writes
`lcov.info`; CI puts its totals in the job summary.

## Stricter Biome rules

On top of the recommended set, [`biome.json`](../../biome.json) turns these on as errors:

- **Correctness:** unused imports, variables, parameters and private members; imports of undeclared dependencies;
  relative imports without their file extension.
- **Promises:** floating promises, promises used where a value is expected, `await` on non-thenables.
- **Tests:** no `.only` and no `.skip`.
- **Playwright:** no `waitForTimeout`, element handles, `force: true`, `networkidle` or un-awaited Playwright calls.
- **Style and safety:** `node:assert/strict`, the `node:` protocol, no non-null assertions, no parameter reassignment,
  only `Error` objects thrown, no `console` (the CLI writes through its `io`), exhaustive `switch` over unions.
- **Import cycles:** no module imports itself through a chain of imports (type-only imports excepted).

## Import boundaries

Enforced with `noRestrictedImports` overrides in `biome.json`:

- The LLM SDKs (`@anthropic-ai/sdk`, `@anthropic-ai/foundry-sdk`, `openai`) are imported only in `src/llm/`, behind
  the provider interface.
- Only `src/cli/` imports `src/cli/`.
- `src/config/` and `src/snapshot/` are leaves: they import no other `src/` module.

## Pinning

Workflow actions and hook revisions are pinned to commit SHAs with the tag in a comment; zizmor fails on an unpinned
`uses:`. Workflows start from `permissions: {}` and grant each job only what it needs, and checkouts do not persist
credentials. Dependabot updates the SHAs and comments.
