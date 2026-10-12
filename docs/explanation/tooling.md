# Tooling choices

- **Test runner: `node:test`.** It ships with Node, so it adds no dependency, and with Node's type stripping the tests
  import the `.ts` sources directly without a build or loader step. Vitest would add a large dependency tree for
  features (watch UI, module mocking) this project does not need.
- **Lint and format: Biome.** One dependency and one config file instead of ESLint, Prettier and plugins. It also
  checks the website's HTML, CSS and SVG. The rule `noTemplateCurlyInString` is off because `${VAR}` is the config's
  placeholder syntax.
- **TypeScript:** strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. `erasableSyntaxOnly`
  forbids enums and namespaces so Node can strip the types, and `rewriteRelativeImportExtensions` lets sources import
  `./x.ts` while the build emits `./x.js`.
- **Config schema:** typed against the TypeScript interface with Ajv's `JSONSchemaType`, so the compiler fails when
  the schema and the type disagree. Defaults live in one object used by both the schema and normalisation.
- **Runtime dependencies:** `playwright` and `ajv` only. Argument parsing uses `node:util` `parseArgs`; the fixture
  site uses `node:http`.
