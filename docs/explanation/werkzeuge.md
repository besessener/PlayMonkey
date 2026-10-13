# Tooling choices

- **Test runner: `node:test`.** It ships with Node, so it adds no dependency, and with Node's type stripping the tests
  import the `.ts` sources directly without a build or loader step. Vitest would add a large dependency tree for
  features (watch UI, module mocking) this project does not need.
- **Lint and format: Biome.** One dependency and one config file instead of ESLint, Prettier and plugins. It also
  checks the website's HTML, CSS and SVG. The rule `noTemplateCurlyInString` is off because `${VAR}` is the config's
  placeholder syntax.
- **Stricter lint and import boundaries in Biome, not ESLint or dependency-cruiser.** Biome covers unused code,
  floating promises, import cycles and restricted imports itself. TypeScript 7 has no JavaScript compiler API, which
  dependency-cruiser's TypeScript parsing relies on. The rules and boundaries are listed in
  [quality gates](../reference/qualitaetssicherung.md).
- **Coverage: Node's built-in.** `--experimental-test-coverage` with `--test-coverage-*` thresholds needs no
  dependency; c8 or Vitest's coverage would add one for the same numbers.
- **Dead code: Knip.** It finds unused files, exports and dependencies, which neither Biome nor `tsc` reports.
- **Hygiene: prek hooks.** gitleaks, zizmor and the standard pre-commit hooks, pinned to commit SHAs.
- **No mutation testing yet.** Stryker has no `node:test` runner; its command runner would rerun whole test files,
  most of which start a browser, for every mutant.
- **TypeScript:** strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. `erasableSyntaxOnly`
  forbids enums and namespaces so Node can strip the types, and `rewriteRelativeImportExtensions` lets sources import
  `./x.ts` while the build emits `./x.js`.
- **Config schema:** typed against the TypeScript interface with Ajv's `JSONSchemaType`, so the compiler fails when
  the schema and the type disagree. Defaults live in one object used by both the schema and normalisation.
- **Runtime dependencies:** `playwright` and `ajv` only. Argument parsing uses `node:util` `parseArgs`; the fixture
  site uses `node:http`.
