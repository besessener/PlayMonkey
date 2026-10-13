# PlayMonkey

![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/browser-Playwright-2EAD33?logo=playwright&logoColor=white)
![Biome](https://img.shields.io/badge/lint-Biome-60A5FA?logo=biome&logoColor=white)
![Knip](https://img.shields.io/badge/dead%20code-Knip-000000?logo=knip&logoColor=white)
![node:test](https://img.shields.io/badge/tested%20with-node%3Atest-339933?logo=nodedotjs&logoColor=white)
![Gitleaks](https://img.shields.io/badge/secrets-Gitleaks-blue?logo=git&logoColor=white)
![zizmor](https://img.shields.io/badge/workflow%20security-zizmor-blue?logo=githubactions&logoColor=white)
[![CI](https://github.com/besessener/PlayMonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/besessener/PlayMonkey/actions/workflows/ci.yml)
[![CodeQL](https://github.com/besessener/PlayMonkey/actions/workflows/codeql.yml/badge.svg)](https://github.com/besessener/PlayMonkey/actions/workflows/codeql.yml)
[![Last commit](https://img.shields.io/github/last-commit/besessener/PlayMonkey)](https://github.com/besessener/PlayMonkey/commits/main)
[![License: MIT](https://img.shields.io/github/license/besessener/PlayMonkey)](LICENSE)

***Lass einen Affen auf deine Testumgebung los.***

`monkey` ist ein Kommandozeilenwerkzeug, das mit Playwright einen echten Browser gegen eine Website in einer
**Wegwerf-Testumgebung** steuert. Mit Seed-gesteuertem Zufall klickt, tippt und sendet es sich durch die Website
und meldet, was kaputtgeht, mit den Schritten zum Nachstellen. Ein LLM springt nur ein, wenn der Zufalls-Monkey
feststeckt.

- **Zufalls-Monkey mit Seed** – klickt Links und Buttons, füllt Formulare mit gültigen und fiesen Werten; derselbe
  Seed ergibt denselben Lauf.
- **Befunde statt Rauschen** – nicht abgefangene Exceptions, Konsolenfehler, HTTP 4xx/5xx, Abstürze, Hänger,
  Fehlerseiten, Layout-Überlauf und fehlgeschlagene Downloads, jeder einmal gemeldet, mit Screenshot, Trace und einem
  abspielbaren Aktionsprotokoll.
- **Ein LLM nur, wenn er feststeckt** – optional; Cookie-Banner, Dialoge oder Formulare, die gültige Daten brauchen,
  bekommen ein paar Modellentscheidungen, und wenn das Modell versagt, macht der Monkey einfach weiter.
- **Nur für Testumgebungen** – bewusst ohne Schutzgeländer: Er klickt auf „Delete“ und sendet jedes Formular ab
  ([Grundregeln](docs/explanation/grundregeln.md)). Kein Testfall-Generator, kein visueller Regressionstest, kein
  Lasttest.

> **Stand:** Version 0.4.0: der Zufalls-Monkey mit Seed, mit Orakeln, Berichten und Replay; Claude auf Microsoft
> Foundry oder jeder OpenAI-kompatible Endpunkt als LLM für festgefahrene Situationen; Cookie-Banner, native Dialoge,
> iframes, Popups, Datei-Uploads und -Downloads werden behandelt; parallele Läufe je Rolle und Seed; ein CI-Beispiel.

## Installation

Voraussetzungen: Node.js 22.18 oder neuer und ein Playwright-Browser. Installiere PlayMonkey in deinem eigenen
Projekt als Dev-Abhängigkeit:

```sh
npm install --save-dev github:besessener/PlayMonkey#v0.4.0
npx playwright install chromium          # on Linux CI: add --with-deps
```

Zum Ausprobieren zuerst gegen die mitgelieferte Fixture-Seite mit eingebauten Fehlern:

```sh
git clone https://github.com/besessener/PlayMonkey.git && cd PlayMonkey
npm ci                                   # installs and builds
npx playwright install chromium
PORT=8080 npm run fixture &              # the fixture site, in the background
export FIXTURE_URL=http://127.0.0.1:8080 FIXTURE_USER=monkey FIXTURE_PASS=banana-split
npx monkey run fixtures/configs/fixture.json
```

Es gibt den Seed aus, eine Zusammenfassung je Rolle, jeden Befund und wo der Bericht liegt:
`fixtures/configs/monkey-report/report.html`. Schritt für Schritt:
[Erste Schritte](docs/tutorials/erste-schritte.md). Releases und Änderungen:
[GitHub Releases](https://github.com/besessener/PlayMonkey/releases).

## Benutzung

```sh
monkey run config.json         # explore the site and report findings
monkey replay actions.json     # re-execute a recorded run, without an LLM
monkey preflight config.json   # check the configured LLM endpoint
monkey run config.json --watch # spectator mode: watch it live, e.g. for a demo
```

Exit-Codes: `0` keine Befunde, `1` Befunde, `2` Werkzeug- oder Konfigurationsfehler oder ein Lauf, der nicht zu Ende
kam; `2` hat Vorrang vor `1`. Eine minimale Konfiguration:

```json
{
  "baseUrl": "https://test.example.org",
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    }
  ]
}
```

Secrets kommen aus Umgebungsvariablen (`${VAR}`) und werden in jeder Ausgabe maskiert. Weiter geht es mit
[Anmeldung einrichten](docs/how-to/anmeldung-einrichten.md), [LLM einrichten](docs/how-to/llm-einrichten.md),
[Parallel ausführen](docs/how-to/parallel-ausfuehren.md), [In der CI ausführen](docs/how-to/in-ci-ausfuehren.md) und
[Einen Befund reproduzieren](docs/how-to/befund-reproduzieren.md); jeder Schlüssel:
[Konfiguration](docs/reference/konfiguration.md).

## Entwicklung

Voraussetzungen: Node.js 22.18 oder neuer.

```sh
npm ci
npx playwright install chromium
npm run check
```

Ausführlich: [Entwicklungsumgebung aufsetzen](docs/tutorials/entwicklungsumgebung.md),
[Befehle](docs/reference/befehle.md) und [CONTRIBUTING.md](CONTRIBUTING.md).

## Dokumentation

Webseite: <https://besessener.github.io/PlayMonkey/>. Die vollständige Dokumentation liegt unter
[docs/](docs/README.md), gegliedert nach [Diátaxis](https://diataxis.fr/):

- **[Tutorials](docs/README.md#tutorials)** – Schritt für Schritt zum ersten Erfolg, z. B. [Erste Schritte](docs/tutorials/erste-schritte.md)
- **[Anleitungen](docs/README.md#anleitungen)** – konkrete Aufgaben lösen, z. B. [Anmeldung einrichten](docs/how-to/anmeldung-einrichten.md) oder [LLM einrichten](docs/how-to/llm-einrichten.md)
- **[Referenz](docs/README.md#referenz)** – genaues Verhalten nachschlagen, z. B. [Konfiguration](docs/reference/konfiguration.md) oder [Befehle](docs/reference/befehle.md)
- **[Hintergrund](docs/README.md#hintergrund)** – verstehen, warum es so ist, z. B. [Architektur](docs/explanation/architektur.md) oder [Grundregeln](docs/explanation/grundregeln.md)

## Verwandte Projekte

PlayMonkey, flakipype und Archivist sind aus derselben agentischen Idee entstanden und teilen Grundregeln,
Qualitätsprüfungen und den Aufbau der Dokumentation:

- [flakipype](https://github.com/besessener/flakipype) – findet, erklärt und behebt instabile („flaky“)
  GitHub-Actions-Pipelines.
- [Archivist](https://github.com/besessener/Archivist) – ein persönlicher, agentischer KI-Archivar für Windows.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
