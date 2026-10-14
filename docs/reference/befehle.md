# Befehle

## `monkey`

```text
monkey run <config.json> [--watch] [--slow-mo <ms>]
                              Explore the site described by the config and report findings.
monkey replay <actions.json> [--config <config.json>] [--strict] [--watch] [--slow-mo <ms>]
                              Re-execute a recorded action log and check which findings recur.
monkey preflight <config.json>
                              Check that the configured LLM endpoint works, without a browser.
monkey shrink <actions.json> [--config <config.json>] [--finding <id>] [--max-replays <n>]
                              Shorten the way to each finding to the fewest actions that still reproduce it.
monkey --help | -h
monkey --version | -v
```

| Befehl | Stand heute |
| --- | --- |
| `run` | Prüft die Konfiguration, gibt den Seed aus, führt den [LLM-Preflight](../how-to/llm-einrichten.md#fehlerbehebung) aus, wenn `llm` gesetzt ist (vor jeder Browserarbeit), und lässt dann den Zufalls-Monkey mit den [Orakeln](../explanation/orakel.md) für jede Rolle und jeden Seed laufen, `parallel` gleichzeitig ([parallel ausführen](../how-to/parallel-ausfuehren.md)). Gibt pro Lauf eine Zusammenfassung aus (Logzeilen beginnen mit `[role]`, mit `seeds` mit `[role/seed]`), eine Zeile pro Befund, den Trace-Pfad und die Gesamtzahl unterschiedlicher Befunde; Screenshots landen in `<report.dir>/<role>/screenshots/`, das [Aktionsprotokoll](aktionsprotokoll.md) in `<report.dir>/<role>/actions.json` (mit `seeds`: `<report.dir>/<role>/<seed>/…`). Schreibt den [Bericht](bericht.md) (`report.json`, eigenständiges `report.html`, `baseline.json`) und endet mit dem LLM-Verbrauch (mit `llm`), der Anzahl pro Schweregrad, dem Vergleich mit `findings.baseline` (wenn gesetzt), der Coverage, dem Berichtspfad und dem Grund für den Exit-Code. |
| `replay` | Führt ein Aktionsprotokoll in einem frischen Kontext für seine Rolle erneut aus, ohne LLM, lässt die Orakel laufen und gibt für jeden aufgezeichneten Befund aus, ob er `reproduced` wurde, dazu `new` Befunde. `--config` (`-c`) liefert Anmelde-, Browser- und Orakeleinstellungen und ist für Rollen nötig, die sich anmelden; `--strict` bricht beim ersten Element ab, das nicht gefunden wird, statt es zu überspringen. Die Ausgabe landet in `replay/` neben dem Protokoll. Siehe [Replay](../explanation/replay.md). |
| `shrink` | Spielt für jeden Befund des Protokolls (oder nur `--finding <id>`) immer kleinere Teilfolgen der Aktionen bis zu seinem Schritt ab und schreibt die kürzeste, die ihn noch auslöst, als `shrink/<id>.actions.json` neben das Protokoll. `--config` wie bei `replay`; `--max-replays` (2 … 1000, Standard 60) begrenzt die Replays pro Befund. Siehe [Kürzen](../explanation/replay.md#kürzen-monkey-shrink). |
| `preflight` | Prüft die Konfiguration und schickt eine Testanfrage an das konfigurierte LLM, die als Tool-Aufruf zurückkommen muss. Gibt `llm preflight ok: …` aus und endet mit `0`, oder gibt Anbieter, bereinigte URL, HTTP-Status, Ursache und einen Hinweis aus und endet mit `2`, auch bei `llm.required: false`. Eine Konfiguration ohne `llm` endet mit `2`. |

`--watch` (`-w`) bei `run` und `replay` ist der [Zuschauermodus](../how-to/lauf-beobachten.md): ein sichtbarer,
verlangsamter Browser, der jedes Element vor der Aktion umrandet und pro Schritt eine Zeile ausgibt; er ändert nie,
welche Aktionen ausgeführt werden. `--slow-mo <ms>` (0 … 99999, Standard 250) setzt die Verzögerung pro
Browseroperation und schließt `--watch` ein.

### Exit-Codes

| Code | Bedeutung |
| --- | --- |
| `0` | Keine Befunde (auch `--help`, `--version`); mit `findings.baseline` keine neuen. Replay: Keiner der aufgezeichneten Befunde trat wieder auf. Shrink: Keiner ließ sich reproduzieren. |
| `1` | Befunde vorhanden; mit `findings.baseline` neue, die die Baseline nicht kennt. Replay: Mindestens ein aufgezeichneter Befund trat wieder auf. Shrink: Mindestens einer wurde reproduziert und gekürzt. |
| `2` | Werkzeug- oder Konfigurationsfehler: falsche Verwendung, unbekannter Befehl oder unbekannte Option, ungültige Konfiguration, eine unlesbare `findings.baseline`, ein Lauf, dessen Anmeldung scheiterte oder der abstürzte (die anderen Läufe laufen trotzdem, und der Bericht wird geschrieben), ein Lauf, der seinen Browser verloren hat, ein fehlgeschlagener LLM-Preflight (außer `llm.required` ist `false`), ein nicht verfügbarer `llm.provider`, `--watch` ohne Display. Replay: außerdem ein unlesbares Aktionsprotokoll, eine nicht unterstützte Protokollversion, eine nicht gesetzte Variable, die das Protokoll braucht, eine Rolle, die in `--config` fehlt, oder ein `--strict`-Replay, das ein Element nicht finden konnte. Shrink: dieselben Fehler wie Replay, ein Protokoll ohne Befunde oder ein unbekanntes `--finding`. |

Vorrang bei `run`: `2`, wenn irgendein Lauf nicht abgeschlossen wurde, auch wenn andere etwas gefunden haben; sonst
`1`, wenn es (neue) Befunde gibt; sonst `0`. Die letzte Zeile der Ausgabe nennt den Grund, z. B.
`exit 2: run broken/4 did not complete`.

## npm-Skripte

| Skript | Macht |
| --- | --- |
| `npm run build` | `tsc` von `src/` nach `dist/`, und macht das `monkey`-Bin ausführbar. |
| `npm test` | Baut, dann `node --test "test/**/*.test.ts"`. |
| `npm run test:coverage` | Baut, führt die Tests mit Abdeckungsmessung von `src/` aus, schlägt unter den [Schwellen](qualitaetssicherung.md#abdeckungsschwellen) fehl, schreibt `lcov.info`. |
| `npm run lint` | `biome ci .` und Typprüfung von `src` und `test`. |
| `npm run typecheck` | Nur die Typprüfung. |
| `npm run knip` | Unbenutzte Dateien, Exporte und Abhängigkeiten. |
| `npm run check` | `lint`, `knip` und `test:coverage`: jede lokale [Qualitätsprüfung](qualitaetssicherung.md). |
| `npm run format` | `biome check --write .`: Formatierung und sichere Korrekturen. |
| `npm run fixture` | Startet die Fixture-Seite, bis sie unterbrochen wird. |
| `npm run prepare` | Führt `build` aus; npm führt es bei `npm ci` aus und wenn PlayMonkey aus Git installiert wird. |

## Umgebungsvariablen

| Variable | Genutzt von | Bedeutung |
| --- | --- | --- |
| jedes `${VAR}` in der Konfiguration | `monkey run` | Secrets und andere Werte, die in die Konfiguration eingesetzt werden. |
| `PORT` | `npm run fixture` | Fester Port für die Fixture-Seite; standardmäßig ein freier. |
| `CHROMIUM_EXECUTABLE_PATH` | `monkey run`, Tests | Startet dieses Chromium statt des für Playwright installierten (nur Engine `chromium`). |
| `FOUNDRY_API_KEY`, `FOUNDRY_BASE_URL`, `FOUNDRY_DEPLOYMENT` | Tests | Opt-in: führt in `test/foundry.test.ts` einen echten `decide`-Aufruf gegen ein Foundry-Deployment aus; wird übersprungen, solange die ersten beiden nicht gesetzt sind. |

`ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_BASE_URL` und `ANTHROPIC_FOUNDRY_RESOURCE`, die das Foundry-SDK von
sich aus liest, werden ignoriert: Endpunkt und Schlüssel kommen nur aus der Konfiguration.
