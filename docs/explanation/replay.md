# Replay

Jeder Befund muss reproduzierbar sein. Der Zufalls-Monkey ist über seinen Seed reproduzierbar, solange die Seite
gleich gerendert wird, LLM-Entscheidungen aber nicht, und eine veränderte Seite schickt einen Lauf mit Seed woanders
hin. Deshalb hält `monkey run` jede ausgeführte Aktion in einem [Aktionsprotokoll](../reference/aktionsprotokoll.md)
fest, und `monkey replay` führt dieses Protokoll erneut aus:

```sh
monkey replay monkey-report/user/actions.json --config config.json
```

## Was Replay tut

1. Liest das Protokoll, prüft seine `version` und löst seine Platzhalter `${VAR}` aus der Umgebung auf, aber nur
   die, die auch deine Konfiguration verwendet (siehe [Fremde Protokolle](#fremde-protokolle)).
2. Öffnet einen frischen Browserkontext für die aufgezeichnete Rolle, angemeldet so, wie die Konfiguration es
   beschreibt. Ohne `--config` lassen sich nur anonyme Protokolle ohne Platzhalter abspielen; Browser- und
   Orakel-Einstellungen sind dann die Standardwerte. `baseUrl`, Viewport und Seed kommen immer aus dem Protokoll,
   wobei `baseUrl` auf dem Origin der `baseUrl` deiner Konfiguration liegen muss.
3. Führt die Aktionen der Reihe nach durch dieselbe Schleife wie `monkey run` aus, mit demselben Umgang mit Seiten:
   Eine Seite, die den Origin der Website verlassen hat, wird zurück zu `baseUrl` geschickt, eine abgestürzte Seite
   wird ersetzt.
4. Lässt dieselben [Orakel](orakel.md) laufen und vergleicht ihre Befunde über den Dedup-Schlüssel mit den
   aufgezeichneten.

Kein LLM ist beteiligt, und Replay braucht weder eine `llm`-Konfiguration noch Netzwerkzugang zu einem LLM:
LLM-Entscheidungen stehen als gewöhnliche Aktionen im Protokoll.

## Fremde Protokolle

Ein Aktionsprotokoll ist eine Eingabe von außen: Das Artefakt `monkey-report` eines CI-Laufs für einen Pull Request
aus einem Fork bestimmt der Fork. Replay und Shrink behandeln jedes Protokoll deshalb als nicht vertrauenswürdig:

- **Platzhalter:** Aufgelöst werden nur Variablen, die deine Konfiguration (`--config`) selbst verwendet. Ein
  Protokoll, das eine andere Variable braucht, wird mit ihrem Namen abgelehnt, auch wenn sie in deiner Umgebung
  gesetzt ist; so kann es sich keine Umgebungsvariable aussuchen. Ohne `--config` wird gar nichts aufgelöst, und ein
  Protokoll mit Platzhaltern braucht `--config`.
- **Origin:** Die `baseUrl` des Protokolls muss eine `http(s)`-URL sein und mit `--config` auf demselben Origin
  (Schema, Host, Port) liegen wie die `baseUrl` deiner Konfiguration. Sonst bricht Replay ab, bevor ein Browser startet
  oder sich jemand anmeldet; deine Zugangsdaten gehen also nur an deine eigene Testumgebung.
- **`navigate`:** Jede `navigate`-Aktion muss dieselben Prüfungen bestehen wie ein Ziel, das das LLM wählt: nur
  `http(s)`, mit `stayOnDomain` nur auf dem Origin der Website und innerhalb von `scope`. Eine Aktion, die das nicht
  tut, lässt Replay das ganze Protokoll ablehnen und nennt ihren Schritt.
- **Befund-Ids:** Ids müssen die Form `F1`, `F2`, … haben, weil Shrink sie als Dateinamen verwendet.

Alles davon endet mit `2` und einer Meldung, die Ursache und nächsten Schritt nennt.

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
keiner, und `2` bei Fehlern (unlesbares Protokoll, nicht unterstützte Version, eine Variable, die das Protokoll braucht und
deine Konfiguration nicht verwendet, ein Protokoll, das die [Prüfungen](#fremde-protokolle) nicht besteht,
fehlgeschlagene Anmeldung, Abdrift mit `--strict`). Replay schreibt seinen Trace, sein Video und seine Screenshots nach `replay/`
neben dem Protokoll.

## Kürzen: `monkey shrink`

Ein Zufallslauf erreicht einen Fehler oft über einen langen Umweg. `monkey shrink` sucht den kürzesten Weg, der ihn
noch auslöst:

```sh
monkey shrink monkey-report/user/actions.json --config config.json
```

Für jeden Befund des Protokolls (oder nur `--finding F2`) nimmt es die Aktionen bis zu seinem Schritt und spielt
immer kleinere Teilfolgen davon ab, jede in einem frischen, angemeldeten Kontext, ohne LLM, Trace und Video. Eine
Teilfolge, in der die Orakel den Dedup-Schlüssel des Befunds wieder melden, ersetzt die bisherige. Das ist **Delta
Debugging** (`ddmin` von Andreas Zeller): erst große Stücke weglassen, dann immer kleinere, bis keine einzelne Aktion
mehr fehlen darf. Die Reihenfolge bleibt erhalten, und keine Teilfolge wird zweimal abgespielt.

Zuerst prüft ein Replay mit allen Aktionen bis zum Befund, ob er sich überhaupt reproduzieren lässt; wenn nicht, gibt
es nichts zu kürzen. `--max-replays` (Standard 60, inklusive dieser Prüfung) begrenzt die Replays pro Befund; ist das
Budget aufgebraucht oder drückst du Strg+C, bleibt das kürzeste Ergebnis bis dahin, mit dem Hinweis
`stopped early, may shrink further`. Nach Strg+C endet `monkey shrink` mit `2`, weil es nicht fertig wurde; ebenso
ein unterbrochenes `monkey replay`.

```text
F1 http5xx: POST /form responded 500 Internal Server Error
  replay 1: 8 actions, reproduced
  replay 2: 4 actions, gone
  …
  8 -> 2 actions: monkey-report/user/shrink/F1.actions.json
shrunk  F1 http5xx: 8 -> 2 actions, 11 replays
```

Das Ergebnis ist ein gewöhnliches Aktionsprotokoll, `shrink/<id>.actions.json` neben dem Eingabeprotokoll, mit den
Schritten neu durchnummeriert, nur diesem Befund und denselben Platzhaltern; `monkey replay` spielt es ab. Der
Exit-Code ist `1`, wenn mindestens ein Befund reproduziert und gekürzt wurde, `0`, wenn keiner reproduziert wurde,
und `2` bei denselben Fehlern wie bei Replay oder einem unbekannten `--finding`.

Gekürzt wird mit Replay ohne `--strict`: Fehlt einer Teilfolge eine Vorbedingung, findet sie Elemente nicht, und
jedes fehlende Element kostet `monkey.actionTimeoutMs`. Eine Konfiguration mit kürzerem Timeout für `--config`
beschleunigt das Kürzen deutlich. Ein Fehler, der vom Timing abhängt, kann sich beim Kürzen anders verhalten;
spiel das Ergebnis dann ein paar Mal ab.
