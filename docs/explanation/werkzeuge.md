# Werkzeugwahl

- **Testrunner: `node:test`.** Er kommt mit Node, bringt also keine Abhängigkeit mit, und mit dem Type Stripping von
  Node importieren die Tests die `.ts`-Quellen direkt, ohne Build- oder Loader-Schritt. Vitest brächte einen großen
  Abhängigkeitsbaum für Funktionen (Watch-Oberfläche, Modul-Mocking), die dieses Projekt nicht braucht.
- **Lint und Formatierung: Biome.** Eine Abhängigkeit und eine Konfigurationsdatei statt ESLint, Prettier und
  Plugins. Biome prüft auch HTML, CSS und SVG der Website. Die Regel `noTemplateCurlyInString` ist aus, weil `${VAR}`
  die Platzhaltersyntax der Konfiguration ist.
- **Strengeres Linting und Importgrenzen in Biome, nicht in ESLint oder dependency-cruiser.** Biome deckt
  ungenutzten Code, nicht abgewartete Promises, Importzyklen und eingeschränkte Importe selbst ab. TypeScript 7 hat
  keine JavaScript-Compiler-API, auf die das TypeScript-Parsing von dependency-cruiser angewiesen ist. Die Regeln und
  Grenzen stehen in den [Qualitätsprüfungen](../reference/qualitaetssicherung.md).
- **Abdeckung: die eingebaute von Node.** `--experimental-test-coverage` mit Schwellen über `--test-coverage-*`
  braucht keine Abhängigkeit; c8 oder die Abdeckung von Vitest brächten eine für dieselben Zahlen.
- **Toter Code: Knip.** Knip findet ungenutzte Dateien, Exporte und Abhängigkeiten, die weder Biome noch `tsc`
  meldet.
- **Hygiene: prek-Hooks.** gitleaks, zizmor und die Standard-Hooks von pre-commit, auf Commit-SHAs festgelegt.
- **Noch keine Mutationstests.** Stryker hat keinen Runner für `node:test`; sein Command-Runner würde für jeden
  Mutanten ganze Testdateien erneut ausführen, von denen die meisten einen Browser starten.
- **TypeScript:** strikt, dazu `noUncheckedIndexedAccess` und `exactOptionalPropertyTypes`. `erasableSyntaxOnly`
  verbietet Enums und Namespaces, damit Node die Typen entfernen kann, und `rewriteRelativeImportExtensions` lässt die
  Quellen `./x.ts` importieren, während der Build `./x.js` ausgibt.
- **Konfigurationsschema:** gegen das TypeScript-Interface typisiert mit `JSONSchemaType` von Ajv, sodass der
  Compiler fehlschlägt, wenn Schema und Typ nicht übereinstimmen. Standardwerte stehen in einem Objekt, das sowohl das
  Schema als auch die Normalisierung verwenden.
- **Laufzeitabhängigkeiten:** nur `playwright` und `ajv`. Das Parsen der Argumente nutzt `node:util` `parseArgs`;
  die Fixture-Seite nutzt `node:http`.
