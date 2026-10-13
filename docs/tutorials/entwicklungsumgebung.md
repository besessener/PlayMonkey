# Entwicklungsumgebung aufsetzen

Vom Klonen bis zu Build, Tests und Lint, die lokal grün sind – dieselben Prüfungen, die auch die CI ausführt.

## Voraussetzungen

- Node.js 26 oder neuer. Die Tests importieren die TypeScript-Quellen direkt über das Type Stripping von Node.
- Ein Playwright-Chromium für die Browsertests.

## Schritte

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run lint
```

`npm test` baut zuerst und führt dann `node --test` auf `test/**/*.test.ts` aus. Dazu gehören Browsertests gegen die
Fixture-Seite. `npm run lint` führt `biome ci` aus und prüft die Typen von `src` und `test`.

`npx playwright install chromium` installiert auch den ffmpeg-Build, mit dem Playwright Videos aufzeichnet. Kannst du
keine Browser installieren (zum Beispiel in einer Sandbox), hast aber ein anderes Chromium, richte die Tests darauf
aus:

```sh
CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm test
```

Die Videoaufzeichnung braucht trotzdem das passende ffmpeg; ohne es schlägt der Videotest fehl.

## Git-Hooks

Die Hooks in `.pre-commit-config.yaml` (gitleaks, zizmor, Dateihygiene) laufen mit [prek](https://github.com/j178/prek)
oder `pre-commit`:

```sh
prek install           # run them on every commit
prek run --all-files   # run them once over the whole tree
```

## Vor dem Push

```sh
npm run format         # apply Biome formatting and safe fixes
npm run check          # lint, types, dead code, tests with coverage thresholds
prek run --all-files
```

Die CI (`.github/workflows/ci.yml`) führt dasselbe aus: einen Hygiene-Job mit gitleaks über die gesamte Historie und
die Hooks, und einen Build-Test-Job, der Chromium mit `--with-deps` installiert und dann Build, Lint, Knip und die
Tests mit Abdeckung auf Node 26 ausführt. `.github/workflows/monkey.yml`, das
[CI-Beispiel](../how-to/in-ci-ausfuehren.md), führt `monkey run` gegen die Fixture-Seite aus, wie es das Projekt eines
Benutzers tun würde. Jede Prüfung und jeder Schwellwert stehen in
[Qualitätsprüfungen](../reference/qualitaetssicherung.md), jedes Skript in [Befehle](../reference/befehle.md).
