# Replay

Jeder Befund muss reproduzierbar sein. Der Zufalls-Monkey ist über seinen Seed reproduzierbar, solange die Seite
gleich gerendert wird, LLM-Entscheidungen aber nicht, und eine veränderte Seite schickt einen Lauf mit Seed woanders
hin. Deshalb hält `monkey run` jede ausgeführte Aktion in einem [Aktionsprotokoll](../reference/aktionsprotokoll.md)
fest, und `monkey replay` führt dieses Protokoll erneut aus:

```sh
monkey replay monkey-report/user/actions.json --config config.json
```

## Was Replay tut

1. Liest das Protokoll, prüft seine `version` und löst seine Platzhalter `${VAR}` aus der Umgebung auf.
2. Öffnet einen frischen Browserkontext für die aufgezeichnete Rolle, angemeldet so, wie die Konfiguration es
   beschreibt. Ohne `--config` lassen sich nur anonyme Protokolle abspielen; Browser- und Orakel-Einstellungen sind
   dann die Standardwerte. `baseUrl`, Viewport und Seed kommen immer aus dem Protokoll.
3. Führt die Aktionen der Reihe nach durch dieselbe Schleife wie `monkey run` aus, mit demselben Umgang mit Seiten:
   Eine Seite, die den Origin der Website verlassen hat, wird zurück zu `baseUrl` geschickt, eine abgestürzte Seite
   wird ersetzt.
4. Lässt dieselben [Orakel](orakel.md) laufen und vergleicht ihre Befunde über den Dedup-Schlüssel mit den
   aufgezeichneten.

Kein LLM ist beteiligt, und Replay braucht weder eine `llm`-Konfiguration noch Netzwerkzugang zu einem LLM:
LLM-Entscheidungen stehen als gewöhnliche Aktionen im Protokoll.

## Elemente wiederfinden

Refs gibt es nur für einen Snapshot, deshalb werden Elemente für Aktionen über ihren **dauerhaften Locator**
gefunden, etwa `getByRole('button', { name: 'Send' })` oder
`locator('iframe').contentFrame().getByRole('link', { name: 'Home' })`. Replay parst diesen Text zurück in einen
Playwright-Locator. Es akzeptiert nur die Locator-Methoden von Playwright mit literalen Argumenten (`getByRole`,
`getByText`, `getByLabel`, `locator`, `contentFrame`, `nth`, …) und wertet den Text nie aus, sodass ein Protokoll
keinen Code ausführen kann.

Auch ein `drag` findet sein Ablageziel über `toLocator`. Native Dialoge und Dateiauswahlen bekommen die Antworten, die
in den `events` des Schritts festgehalten sind (angenommen oder abgelehnt, der Prompt-Text, die Namen der
hochgeladenen Dateien), sodass ein Replay denselben Weg durch `confirm`-Dialoge und Uploads nimmt wie die
Aufzeichnung.

Jedes Element hat `monkey.actionTimeoutMs` Zeit, zu erscheinen. Tut es das nicht, ist die Seite seit der Aufzeichnung
**abgedriftet**: Replay protokolliert `step N skipped: element not found: …` und macht mit der nächsten Aktion weiter.
Mit `--strict` hält es stattdessen dort an und endet mit `2`.

## Ergebnis

```text
reproduced      F1 medium console: Seeded bug: console error on load
not reproduced  F2 high http5xx: POST /form responded 500 Internal Server Error
new             F3 low overflow: horizontal overflow on /overflow: div makes the page 1664px wide in a 1280px viewport (step 26)
reproduced: 1 of 2
```

Jeder aufgezeichnete Befund ist `reproduced` oder `not reproduced`; Befunde, die die Aufzeichnung nicht hatte,
erscheinen als `new`. Der Exit-Code ist `1`, wenn mindestens ein aufgezeichneter Befund reproduziert wurde, `0`, wenn
keiner, und `2` bei Fehlern (unlesbares Protokoll, nicht unterstützte Version, fehlende Variable, fehlgeschlagene
Anmeldung, Abdrift mit `--strict`). Replay schreibt seinen Trace, sein Video und seine Screenshots nach `replay/`
neben dem Protokoll.
