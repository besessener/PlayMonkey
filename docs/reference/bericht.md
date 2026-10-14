# Bericht

`monkey run` schreibt alles nach `report.dir` (Standard `./monkey-report`, relativ zur Konfigurationsdatei):

```text
monkey-report/
  report.html              one self-contained page: open it in any browser, also offline
  report.json              the same data, machine-readable
  baseline.json            this run's findings, to adopt as findings.baseline
  llm-debug.jsonl          only with llm.debugLog: every LLM prompt and response, sanitized
  <role>/
    actions.json           the action log, see aktionsprotokoll.md
    trace.zip              Playwright trace: npx playwright show-trace <role>/trace.zip
    video/*.webm           video of each page of the role
    screenshots/step-NNNN.png
                           one screenshot per step that produced a new finding
    downloads/             only with report.keepDownloads
```

Mit `seeds` in der Konfiguration bekommt jeder Lauf ein eigenes Verzeichnis, `<role>/<seed>/`, mit demselben Inhalt
(`admin/42/actions.json`, `admin/42/trace.zip`, …); `report.json` und `report.html` bleiben ein gemeinsamer Bericht
auf oberster Ebene.

Am Ende eines Laufs sagt die Konsole, wie viele Befunde welches Schweregrads es gibt, wo der Bericht liegt und warum
der Exit-Code so ist, wie er ist:

```text
llm: 14 calls (1 failed), 81234 in / 912 out tokens (60110 cached), 5 handoffs, 12 actions, 1 fallback, p95 2310 ms
findings: 5 (2 high, 2 medium, 1 low)
coverage: 12 pages visited, 2 linked pages never visited
report: …/monkey-report/report.html
exit 1: findings present
```

## `report.html`

Eine einzelne Datei mit eingebettetem CSS und den Screenshots als eingebettete Bilder; sie hat keine Skripte und lädt
nichts aus dem Netz. Sie zeigt:

- den Lauf (Basis-URL, Seed, Startzeit, Werkzeugversion) und die Anzahl der Befunde pro Schweregrad;
- eine Zeile pro Lauf (Rolle und Seed): Schritte, Dauer, warum er endete, Befunde und Links zu seinem
  Aktionsprotokoll, Trace und Video;
- mit `llm`: eine Tabelle **LLM usage** (gesamt und pro Rolle) und Hinweise, wenn das LLM abgeschaltet war oder sein
  Budget aufgebraucht ist;
- die Befunde, über alle Läufe zusammengefasst: eine Karte pro Problem, sortiert nach Schweregrad, dann nach der Zahl
  der Läufe, die es gefunden haben, dann danach, wie oft es auftrat. Jede zeigt ihr Orakel, ihre Meldung und Seite,
  **found in** (die Rollen, z. B. „admin, user“), die Läufe mit ihren Befund-Ids pro Lauf und, aus dem ersten Lauf,
  der es gefunden hat, die **steps to reproduce** (die letzten `findings.lastActions` Aktionen, ausgeschrieben mit
  ihren dauerhaften Locatoren), den Screenshot und die Details, die das Orakel festgehalten hat;
- mit `findings.baseline`: die Zahl neuer und bekannter Befunde im Kopf, das Abzeichen **known** auf bekannten
  Befunden und unter **Not seen this time** die Befunde der Baseline, die dieser Lauf nicht gefunden hat (behoben,
  oder diesmal nicht erreicht);
- die **Coverage**: eine Zeile pro Seite, auf der ein Lauf gehandelt hat (Schritte, Läufe), und die Seiten, zu denen
  ein Lauf Links gesehen, die aber keiner erreicht hat. So fällt auf, wenn ein Lauf zum Beispiel nie bis zur Kasse
  kam.

Seiten heißen in der Coverage wie in den Dedup-Schlüsseln: URL ohne Query und Fragment, IDs als `:n` und `:id`, der
eigene Origin weggelassen (siehe [Deduplizierung](../explanation/orakel.md#deduplizierung)). Als erreichbar zählen nur
Links, denen der Monkey folgen darf (`stayOnDomain`, `scope`).

Alles, was angezeigt wird, stammt von der getesteten Seite oder aus der Konfiguration, daher ist alles HTML-escaped.
Links zu Traces und Videos sind relativ; halte das Verzeichnis also zusammen, wenn du es verschiebst.

## `report.json`

| Feld | Bedeutung |
| --- | --- |
| `version` | Formatversion, derzeit `1`. |
| `tool` | `{ "name": "playmonkey", "version": … }`. |
| `startedAt`, `finishedAt` | ISO-Zeitstempel des Laufs. |
| `seed` | Der Seed des Laufs; mit `seeds` der erste davon. |
| `seeds` | Nur mit `seeds` in der Konfiguration: alle. |
| `config` | Die Konfiguration mit eingesetzten Standardwerten, jeder geheime Wert als `***` maskiert. |
| `roles[]` | Ein Eintrag pro Lauf, in der Reihenfolge der Konfiguration (Rollen, dann Seeds), egal in welcher Reihenfolge sie fertig wurden: `role`, `seed`, `steps`, `durationMs`, `stopReason` (`maxSteps`, `maxMinutes`, `aborted`, `error`), `error`, `states`, `failedActions`, `pages` (Seiten der Coverage), `findings` (Anzahl), `blockedNavigations`, `sessionLosses` (wie oft die Rolle ihre Sitzung verloren hat, siehe [Sitzungen](../explanation/sitzungen.md#verlorene-sitzung)) und die Pfade `actionLog`, `trace`, `videos`. Ein Lauf, der sich nicht anmelden konnte, abgestürzt ist oder wegen einer Unterbrechung nicht mehr startete (`error`: `not started: interrupted`), hat nur `role`, `seed`, `error`, `findings: 0` und leere `videos`. |
| `findings[]` | Die Befunde jedes Laufs, pro Lauf dedupliziert, wie in [Orakel und Befunde](../explanation/orakel.md#befundmodell) beschrieben, dazu der `seed` des Laufs und `screenshot` als Pfad. Sortiert nach Schweregrad, dann Vorkommen, dann Reihenfolge der Läufe. Ids (`F1`, …) zählen pro Lauf. |
| `aggregated[]` | Die Befunde über alle Läufe, einer pro Dedup-Schlüssel: `key`, `oracle`, `severity`, `message`, `url` (des ersten Laufs, der ihn gefunden hat), `occurrences` (Summe), `roles` (eindeutig, Reihenfolge der Konfiguration), `runs[]` (`role`, `seed`, `id`) und, mit `findings.baseline`, `known`. Sortiert wie im HTML. |
| `baseline` | Nur mit `findings.baseline`: `file` (relativ zum Berichtsverzeichnis), `known` und `new` (Anzahl der Befunde, die die Baseline kennt oder nicht kennt; `new` entscheidet über den Exit-Code) und `unseen[]`: Einträge der Baseline, die dieser Lauf nicht gefunden hat. |
| `counts` | Zusammengefasste Befunde pro Schweregrad: `critical`, `high`, `medium`, `low`. |
| `coverage` | `pages[]` (`page`, `steps` summiert über die Läufe, `runs`: wie viele Läufe dort gehandelt haben), sortiert nach Seite, und `unvisited[]`: Seiten, zu denen ein Lauf Links gesehen hat und die keiner erreicht hat. |
| `llm` | Nur mit `llm` in der Konfiguration; siehe unten. |

Pfade sind relativ zum Berichtsverzeichnis.

### `llm`

| Feld | Bedeutung |
| --- | --- |
| `provider`, `deployment` | Das Backend und das Deployment. |
| `status` | `active`, oder `disabled`, wenn der Preflight mit `llm.required: false` fehlgeschlagen ist (`disabledReason` sagt, warum). |
| `preflight` | `{ ok, latencyMs }` oder `{ ok: false, error }`. Seine Tokens werden unten nicht mitgezählt. |
| `budget` | `maxCalls`, `maxTokens` wie konfiguriert und `exhausted: { role, step, reason }`, sobald das Budget aufgebraucht war; der Rest des Laufs war reiner Monkey. |
| `pricing` | Wiedergabe von `llm.pricing`, wenn gesetzt. |
| `total`, `roles[]` | Verbrauch des ganzen Aufrufs und pro Lauf (`roles[].role`: die Rolle, oder `role/seed` mit `seeds`), siehe unten. |

Jeder Verbrauchseintrag hat `calls`, `failedCalls`, `errors` (fehlgeschlagene Aufrufe nach Art, z. B.
`{ "rateLimited": 2 }`), `inputTokens` (Eingabe-Tokens ohne Cache-Zugriffe), `outputTokens`, `cachedTokens`
(Cache-Lesezugriffe), `cacheWriteTokens` (Cache-Schreibzugriffe), `retries` (Anfragen, die das SDK wiederholt hat;
zählen nicht als Aufrufe), `handoffs` (nach Auslöser, siehe
[das LLM](../explanation/llm.md#wann-der-monkey-übergibt)), `actions` (ausgeführte Aktionen, die das LLM gewählt
hat), `fallbacks` (Schritte, in denen der Monkey gehandelt hat, weil das LLM fehlschlug, nach Fehlerart),
`breakerTrips`, `avgLatencyMs`, `p95LatencyMs` und, mit `llm.pricing`, `estimatedCost`: eine **Schätzung** in der
Währung der Preise, keine Rechnung.

Die vier Token-Zahlen überschneiden sich bei jedem Anbieter nicht: OpenAI zählt Cache-Zugriffe in seinen
Eingabe-Tokens mit, PlayMonkey zieht sie davon ab. Ihre Summe ist, was der Anbieter berechnet und was gegen
`llm.maxTokens` zählt.

## `baseline.json`

Jeder Lauf schreibt die Befunde, die er gefunden hat, als `baseline.json`: `version` (derzeit `1`) und `findings[]`
mit `key`, `oracle`, `severity` und `message`, nach `key` sortiert, damit ein Diff klein bleibt. Maskiert wie
`report.json`. Nur `key` entscheidet beim Vergleich; der Rest ist für Menschen, die die Datei lesen. Wie du sie als
Baseline übernimmst, steht in [In der CI ausführen](../how-to/in-ci-ausfuehren.md#nur-neue-befunde-mit-einer-baseline).

## `llm-debug.jsonl`

Wird nur mit `llm.debugLog: true` geschrieben; sonst wird nirgends ein Prompt oder eine Antwort gespeichert. Ein
JSON-Objekt pro LLM-Aufruf: `time`, `role`, `step`, `attempt`, `prompt` (die Benutzernachricht), `input` (ihre
Teile), `result` oder `error` und `response` (die Rohantwort des Anbieters). Prompts enthalten nie geheime Werte
(siehe [Platzhalter](../explanation/llm.md#secrets-und-platzhalter)); jede Zeichenkette wird vor dem Schreiben noch
einmal maskiert.

## Secrets

`report.json`, `report.html`, `llm-debug.jsonl` und die Konsole maskieren jedes
[Secret](konfiguration.md#secrets-var), auch URL-kodiert oder in einem JSON-String und bevor ein Wert gekürzt wird;
`actions.json` speichert stattdessen den Platzhalter, damit sich das Protokoll wiederholen lässt. Dedup-Schlüssel
werden vor der Deduplizierung maskiert, Rollennamen nie: Sie sind keine Secrets.

Die Screenshots der Befunde (im Ordner `screenshots/` und eingebettet in `report.html`) schwärzen jedes
Passwortfeld und jedes Feld, dessen Wert ein Secret enthält. Text, den die Seite selbst anzeigt, etwa ein
zurückgegebener Benutzername, bleibt darauf lesbar, ebenso Felder in Iframes; kann die Seite die Felder nicht rechtzeitig
markieren, entsteht kein Screenshot. Ein Test lässt die Fixture-Seite mit eigenen Zugangsdaten laufen und durchsucht jede Textdatei des
Berichtsverzeichnisses danach.

**Traces und Videos sind nicht maskiert.** Playwright kann einen Trace nicht schwärzen, und er zeichnet auf:

- die Kontextoptionen, einschließlich `baseURL` und des Storage State mit dem **Sitzungs-Cookie** der Anmeldung;
- jede Anfrage und Antwort mit URLs, Headern und Cookies;
- jeden Wert, den der Monkey eingetippt hat, einschließlich Testdaten aus `${VAR}`-Platzhaltern;
- Screenshots und DOM-Snapshots sowie das Video von allem, was die Seiten angezeigt haben.

Passwörter einer Formularanmeldung sind nicht darin: Die Anmeldung läuft in einem eigenen Kontext ohne Trace und
Video. Behandle `trace.zip` und die Videos wie die Sitzungsdaten der Testumgebung, und veröffentliche sie nicht.
