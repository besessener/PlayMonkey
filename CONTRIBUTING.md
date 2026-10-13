# Mitmachen

Danke, dass du hilfst. PlayMonkey ist ein kleines TypeScript-CLI auf Basis von Playwright; die
[Dokumentation](docs/README.md) erklärt, wie es funktioniert.

## Einrichten

Node.js 22.18 oder neuer:

```sh
npm ci                            # installs and builds (prepare)
npx playwright install chromium
```

Ausführlich, auch für Sandboxes ohne Playwright-Browser:
[Entwicklungsumgebung aufsetzen](docs/tutorials/entwicklungsumgebung.md).

## Arbeiten

| Aufgabe | Befehl |
| --- | --- |
| `src/` nach `dist/` bauen | `npm run build` |
| Alle Tests (baut vorher) | `npm test` |
| Eine Testdatei | `node --test test/report.test.ts` |
| Lint und Typprüfung | `npm run lint` |
| Alle lokalen Qualitätsprüfungen | `npm run check` |
| Formatieren und sichere Korrekturen | `npm run format` |
| Fixture-Seite mit eingebauten Fehlern | `npm run fixture` |
| CLI ausprobieren | `npx monkey run fixtures/configs/fixture.json` |

Tests nutzen `node:test` und führen die TypeScript-Quellen direkt aus. End-to-End-Tests starten die
[Fixture-Seite](fixtures/README.md) selbst; eine neue Fehlerart bekommt zuerst eine Fixture-Seite, dann den Code,
dann einen Test, dass sie genau einmal gemeldet wird.

## Bevor du einen Pull Request öffnest

```sh
npm run format
npm run check          # lint, types, dead code, tests with coverage thresholds
prek run --all-files   # gitleaks, zizmor, file hygiene
```

- Halte Änderungen fokussiert: ein Thema je Pull Request.
- Die Dokumentation wandert mit dem Code. Ein neuer Konfigurationsschlüssel gehört in `src/config/schema.ts`
  (`llm.*`-Schlüssel in `src/config/llm-schema.ts`, Standardwerte in `src/config/defaults.ts`) **und** in die
  [Konfiguration](docs/reference/konfiguration.md); sonst schlägt `test/docs.test.ts` fehl. Der Test prüft außerdem
  relative Links und Anker, dass sich jede Beispielkonfiguration parsen lässt und dass das
  [CI-Beispiel](docs/how-to/in-ci-ausfuehren.md) mit `.github/workflows/monkey.yml` übereinstimmt.
- Kein Secret darf in eine Ausgabe gelangen: Werte aus `${VAR}`-Platzhaltern werden überall maskiert, siehe die
  [Grundregeln](docs/explanation/grundregeln.md).

Die CI führt alle [Qualitätsprüfungen](docs/reference/qualitaetssicherung.md) aus (`ci.yml`, `codeql.yml`) und
das CI-Beispiel gegen die Fixture-Seite (`monkey.yml`).

## Veröffentlichen

Änderungen stehen in den [GitHub Releases](https://github.com/besessener/PlayMonkey/releases).

1. Setze die Version mit `npm version X.Y.Z --no-git-tag-version` und aktualisiere den festgelegten Tag (`#vX.Y.Z`)
   in der [README](README.md), in [In der CI ausführen](docs/how-to/in-ci-ausfuehren.md) und in `site/index.html`.
   Merge das über einen Pull Request.
2. Tagge den Merge-Commit auf `main` und pushe den Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

`.github/workflows/release.yml` prüft dann, dass der Tag zu `package.json` passt, und veröffentlicht ein
GitHub-Release mit Notizen, die aus den gemergten Pull Requests erzeugt werden.

## Erweitern

- Ein neues LLM-Backend: [Ein Backend hinzufügen](docs/explanation/llm.md#ein-backend-hinzufügen).
- Ein neues Orakel: [Ein Orakel hinzufügen](docs/explanation/orakel.md#ein-orakel-hinzufügen).
