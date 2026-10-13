# Erste Schritte

Dieses Tutorial führt dich von einem frischen Klon zu einem ersten `monkey run` gegen die lokale Fixture-Seite. Du
brauchst Node.js 26 oder neuer (die Fixture-Seite führt TypeScript direkt aus) und git. Ein LLM ist nicht nötig.

## 1. Installieren

```sh
git clone https://github.com/besessener/PlayMonkey.git
cd PlayMonkey
npm ci                             # also builds the CLI
npx playwright install chromium    # on Linux: --with-deps installs the system libraries too
npx monkey --help
```

## 2. Die Fixture-Seite starten

Das Repository bringt eine kleine Seite mit absichtlich eingebauten Fehlern mit. In einem zweiten Terminal:

```sh
npm run fixture
```

Sie gibt ihre URL, die Testanmeldung und die Variablen aus, die die Beispielkonfiguration braucht, zum Beispiel:

```text
Fixture site running at http://127.0.0.1:41234
Login: monkey / banana-split
For fixtures/configs/fixture.json:
  export FIXTURE_URL=http://127.0.0.1:41234 FIXTURE_USER=monkey FIXTURE_PASS=banana-split
```

## 3. Den Monkey laufen lassen

Kopier die Zeile mit `export` in dein erstes Terminal, dann:

```sh
npx monkey run fixtures/configs/fixture.json
```

Der Monkey meldet sich als Rolle `user` an, geht 300 zufällige Schritte (`limits.maxSteps` der Konfiguration) und gibt
eine Zusammenfassung mit den fünf eingebauten Fehlern aus, jeder einmal gemeldet, egal, wie oft der Monkey darauf
gestoßen ist:

```text
seed: 42
[user] starting
[user] 300 steps in 37.1s, 47 states, 0 failed actions, stopped: maxSteps, 5 findings
[user]   F1 medium console: Seeded bug: console error on load (step 1, 14×)
[user]   F2 high pageerror: Error: Seeded bug: click handler crashed (step 18, 12×)
[user]   F3 medium http4xx: GET /missing-page responded 404 Not Found (step 20, 10×)
[user]   F4 low overflow: horizontal overflow on /overflow: div makes the page 1664px wide in a 1280px viewport (step 26, 12×)
[user]   F5 high http5xx: POST /form responded 500 Internal Server Error (step 99, 2×)
[user] actions: …/fixtures/configs/monkey-report/user/actions.json
[user] trace: …/fixtures/configs/monkey-report/user/trace.zip
findings: 5 (2 high, 2 medium, 1 low)
report: …/fixtures/configs/monkey-report/report.html
exit 1: findings present
```

Öffne `fixtures/configs/monkey-report/report.html` im Browser: jeder Befund mit seinen Schritten zum Reproduzieren,
einem Screenshot und Links zu Trace und Video. Dieselben Daten stehen in `report.json`; siehe die
[Referenz zum Bericht](../reference/bericht.md).

Sieh dir an, was er getan hat, mit `npx playwright show-trace fixtures/configs/monkey-report/user/trace.zip`, oder
schau dir das Video daneben an. Führ ihn noch einmal aus: Mit demselben Seed geht er dieselben Schritte.

## 4. Den Lauf abspielen

Jede Aktion ist in `actions.json` gelandet. Spiel sie ab, mit der Konfiguration für die Anmeldung:

```sh
npx monkey replay fixtures/configs/monkey-report/user/actions.json --config fixtures/configs/fixture.json
```

Replay wiederholt die 300 Schritte, ohne etwas auszuwählen, und prüft, welche Befunde wieder auftreten:

```text
[user] replaying 300 actions
[user] 300 steps in 29.3s, 47 states, 0 failed actions, stopped: end, 5 findings
…
reproduced      F1 medium console: Seeded bug: console error on load
reproduced      F2 high pageerror: Error: Seeded bug: click handler crashed
reproduced      F3 medium http4xx: GET /missing-page responded 404 Not Found
reproduced      F4 low overflow: horizontal overflow on /overflow: div makes the page 1664px wide in a 1280px viewport
reproduced      F5 high http5xx: POST /form responded 500 Internal Server Error
reproduced: 5 of 5
```

Das Protokoll speichert die URL und die Anmeldung als `${FIXTURE_URL}` und Co., deshalb lässt es sich auch abspielen,
nachdem du die Fixture-Seite auf einem anderen Port neu gestartet hast. Siehe [Replay](../explanation/replay.md).

## 5. Einen Konfigurationsfehler sehen

Entferne eine Variable und führ den Lauf noch einmal aus:

```sh
unset FIXTURE_PASS
npx monkey run fixtures/configs/fixture.json
echo $?
```

Der Fehler nennt den Konfigurationspfad und die Variable (`auth[0].fields.password: environment variable FIXTURE_PASS is
not set`), nie einen Wert, und der Exit-Code ist `2`.

## Als Nächstes

- Eine Konfiguration für deine eigene Testumgebung schreiben: [Referenz zur Konfiguration](../reference/konfiguration.md).
- Rollen und Anmeldungen einrichten: [Anmeldung einrichten](../how-to/anmeldung-einrichten.md).
- Ein LLM helfen lassen, wenn der Monkey festgefahren ist: [LLM einrichten](../how-to/llm-einrichten.md).
- Mehr Rollen und Seeds auf einmal: [Parallel ausführen](../how-to/parallel-ausfuehren.md).
- Bei jedem Pull Request ausführen: [In der CI ausführen](../how-to/in-ci-ausfuehren.md).
