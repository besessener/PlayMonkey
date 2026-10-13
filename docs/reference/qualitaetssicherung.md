# Qualitätsprüfungen

Jede Prüfung unten läuft in CI bei jedem Pull Request und jedem Push auf `main`. `npm run check` führt die lokalen in
einem Rutsch aus; siehe [Entwicklungsumgebung aufsetzen](../tutorials/entwicklungsumgebung.md).

| Prüfung | Befehl | Prüft | Workflow |
| --- | --- | --- | --- |
| Formatierung und Lint | `npm run lint` (`biome ci .`) | Formatierung, Biomes empfohlene Regeln plus die strengeren Regeln und Importgrenzen unten | `ci.yml` |
| Typen | `npm run typecheck` (Teil von `lint`) | `tsc` strict über `src`, `test` und `fixtures` | `ci.yml` |
| Toter Code | `npm run knip` | Unbenutzte Dateien, Exporte, Typen und Abhängigkeiten ([`knip.json`](../../knip.json)) | `ci.yml` |
| Tests und Abdeckung | `npm run test:coverage` | Alle Tests, dazu Zeilen-, Zweig- und Funktionsabdeckung von `src/` über den Schwellen | `ci.yml` |
| Secrets | `gitleaks git` | Die ganze Git-Historie ([`.gitleaks.toml`](../../.gitleaks.toml)) | `ci.yml`, Job hygiene |
| Dateihygiene und Workflows | `prek run --all-files` | Merge-Marker, YAML/JSON-Syntax, Dateien über 1 MB, private Schlüssel, Leerzeichen am Zeilenende, abschließender Zeilenumbruch, Zeilenenden; zizmor prüft die Workflows | `ci.yml`, Job hygiene |
| Code-Scanning | CodeQL `security-extended` | JavaScript/TypeScript und die Workflows; Ergebnisse unter Security → Code scanning | `codeql.yml`, auch wöchentlich |
| Abhängigkeitsupdates | Dependabot | npm-Pakete, Actions und Hook-Revisionen, wöchentlich mit 7 Tagen Wartezeit | `dependabot.yml` |

## Abdeckungsschwellen

`npm run test:coverage` nutzt Nodes eingebaute Abdeckungsmessung (`--experimental-test-coverage`) und schlägt fehl
unter:

| Metrik | Schwelle | Gemessen (2026-10) |
| --- | --- | --- |
| Zeilen | 97 % | 98,2 % |
| Zweige | 88 % | 90,1 % |
| Funktionen | 93 % | 96,4 % |

Die Schwellen liegen knapp unter den gemessenen Werten und werden nur angehoben, nie gesenkt. Der Lauf schreibt
außerdem `lcov.info`; CI übernimmt dessen Summen in die Job-Zusammenfassung.

## Strengere Biome-Regeln

Zusätzlich zum empfohlenen Satz stellt [`biome.json`](../../biome.json) etwa 140 Regeln auf Fehler. Die wichtigsten
Gruppen:

- **Größe und Komplexität:**

  | Limit | Wert | Gilt für |
  | --- | --- | --- |
  | Kognitive Komplexität pro Funktion | 15 | alles |
  | Parameter pro Funktion | 4, sonst ein benanntes Optionsobjekt | alles |
  | Zeilen pro Funktion (Leerzeilen nicht mitgezählt) | 50 | `src/`, `fixtures/` (keine Test-Suites) |
  | Zeilen pro Datei (Leerzeilen nicht mitgezählt) | 350 in `src/` und `fixtures/`, 600 in `test/` | alles |

- **Korrektheit:** unbenutzte Imports, Variablen, Parameter, Labels und private Member; Imports nicht deklarierter
  Abhängigkeiten; relative Imports ohne Dateiendung; keine verdeckten Namen; kein `== null`.
- **Promises:** nicht abgewartete Promises, Promises, wo ein Wert erwartet wird, `await` auf Nicht-Thenables,
  `async`-Funktionen ohne `await`, Rejections mit Werten, die kein `Error` sind.
- **Typen:** kein `any`, kein implizites `any` in `let`, keine sich entwickelnden Typen, strikte boolesche
  Bedingungen, kein `@ts-ignore`, keine Non-Null-Assertions.
- **Tests:** kein `.only`, kein `.skip`, keine gleichen Testtitel, keine tief verschachtelten Suites.
- **Playwright:** kein `waitForTimeout`, keine Element-Handles, kein `force: true`, kein `networkidle` und keine
  nicht abgewarteten Playwright-Aufrufe.
- **Moderner, eindeutiger Code:** `node:`-Imports, `node:assert/strict`, `for…of` statt `forEach`, `at()`,
  `includes()`, `startsWith()`, `??`, Template-Literale, Zifferntrenner, keine verschachtelten ternären Ausdrücke,
  keine impliziten Typumwandlungen, kein `delete`, keine Barrel-Dateien oder `export *`, einheitliche Array- und
  Typdefinitionen, `readonly`-Klassenfelder, wo möglich.
- **Umgebung:** `process.env` wird nur in `src/config/`, `src/cli/` und `src/auth/browser.ts` gelesen, damit Werte
  über die Konfiguration in den Code gelangen, wo sie maskiert werden.
- **Ausgabe:** kein `console` (die CLI schreibt über ihr `io`).
- **Importzyklen:** Kein Modul importiert sich selbst über eine Kette von Imports (reine Typ-Imports ausgenommen).

Bewusst abgeschaltet:

| Regel | Warum |
| --- | --- |
| `useErrorCause` | Ein abgefangener Fehler kann ein unmaskiertes Secret tragen (zum Beispiel behält ein `TypeError` aus `new URL()` die ausgefüllte URL in seinem `input`); ein neu geworfener Fehler sagt ohne ihn, was fehlgeschlagen ist. |
| `noAwaitInLoops` | Browserschritte laufen absichtlich nacheinander. |
| `useDefaultSwitchClause` | Ein vollständiges `switch` über eine Union (`useExhaustiveSwitchCases`) fängt ein neues Element schon beim Kompilieren ab; ein `default` würde es verstecken. |
| `noVoid` | `void` kennzeichnet die Fire-and-forget-Promises, die `noFloatingPromises` ausdrücklich verlangt. |
| `noSecrets` | Entropiebasiert und auf Testdaten zu laut; gitleaks ist die Prüfung für Secrets. |
| `noMagicNumbers`, `useBlockStatements`, `useNamingConvention`, `useExplicitReturnType` | Stilregeln, die Hunderte Zeilen umwälzen würden; `useNamingConvention` würde außerdem die Feldnamen der LLM-APIs ablehnen (`max_tokens`). |

## Importgrenzen

Erzwungen mit `noRestrictedImports`-Overrides in `biome.json`:

- Die LLM-SDKs (`@anthropic-ai/sdk`, `@anthropic-ai/foundry-sdk`, `openai`) werden nur in `src/llm/` importiert,
  hinter der Anbieter-Schnittstelle.
- Nur `src/cli/` importiert `src/cli/`.
- `src/config/` und `src/snapshot/` sind Blätter: Sie importieren kein anderes `src/`-Modul.

## Pinning

Workflow-Actions und Hook-Revisionen sind auf Commit-SHAs festgelegt, mit dem Tag in einem Kommentar; zizmor schlägt
bei einem nicht festgelegten `uses:` fehl. Workflows beginnen mit `permissions: {}` und geben jedem Job nur, was er
braucht, und Checkouts speichern keine Zugangsdaten. Dependabot aktualisiert die SHAs und Kommentare.
