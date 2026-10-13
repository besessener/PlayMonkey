# Einen Befund reproduzieren

Jeder Befund bringt mit, was du brauchst, um ihn wieder zu sehen: den Seed, das Aktionsprotokoll, einen Trace und die
ausgeschriebenen Schritte im Bericht.

## 1. Die Schritte im Bericht lesen

Öffne `report.html`. Jeder Befund listet die letzten `findings.lastActions` Aktionen davor auf (Standard 10), mit
dauerhaften Locators wie `getByRole('button', { name: 'Send' })`, der Seite und einem Screenshot. Oft reicht das, um
ihn von Hand zu wiederholen. Erhöhe `findings.lastActions`, wenn die Ursache weiter zurückliegt.

## 2. Den Trace ansehen

```sh
npx playwright show-trace monkey-report/user/trace.zip
```

Der [Trace Viewer](https://playwright.dev/docs/trace-viewer) zeigt jede Aktion mit dem DOM davor und danach, die
Konsole, das Netzwerk und Screenshots. Spring zu dem Schritt, den der Befund nennt (`first at step N`). Das Video neben
dem Trace zeigt dasselbe ohne die Details. Mit `seeds` liegen die Dateien in `<role>/<seed>/`.

## 3. Das Aktionsprotokoll abspielen

```sh
npx monkey replay monkey-report/user/actions.json --config config.json
```

Replay führt die aufgezeichneten Aktionen in einem frischen, angemeldeten Kontext erneut aus, ohne Zufall und ohne
LLM, lässt die Orakel laufen und gibt für jeden aufgezeichneten Befund aus, ob er `reproduced` wurde. Exit-Code `1`
heißt, dass mindestens einer wieder aufgetreten ist. Mit `--watch` kannst du [zusehen](lauf-beobachten.md), mit
`--strict` hält Replay beim ersten Element an, das nicht mehr da ist. Wie es funktioniert und was Drift bedeutet:
[Replay](../explanation/replay.md).

## 4. Oder den Seed erneut ausführen

Der Seed wird zu Beginn jedes Laufs ausgegeben und in `report.json` und `actions.json` gespeichert. Mit demselben
Seed, derselben Konfiguration und einer unveränderten Seite geht der zufällige Monkey dieselben Schritte:

```json
{ "baseUrl": "https://test.example.org", "seed": 1234567 }
```

Eine geänderte Seite oder Entscheidungen des LLM lenken einen Lauf mit Seed woandershin; das Aktionsprotokoll hängt
von beidem nicht ab, deshalb ist Replay der verlässliche Weg.

## Befunde aus der CI

Lade das Artefakt `monkey-report` des CI-Laufs herunter (siehe [In der CI ausführen](in-ci-ausfuehren.md)), entpacke
es und spiel seine `actions.json` gegen dieselbe Testumgebung ab, mit denselben gesetzten Umgebungsvariablen.
