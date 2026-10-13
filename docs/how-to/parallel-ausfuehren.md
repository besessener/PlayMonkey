# Parallel ausführen

Mehrere Rollen, oder dieselbe Rolle mit mehreren Seeds, decken in derselben Zeit mehr von einer Seite ab. Jeder Lauf
ist eine Rolle mit einem Seed, in einem eigenen Browserkontext (Cookies und Storage vermischen sich nie), in einem
gemeinsamen Browser.

```json
{
  "baseUrl": "https://test.example.org",
  "seeds": [1, 2, 3],
  "parallel": 3,
  "limits": { "maxSteps": 300, "maxMinutes": 10 },
  "auth": [
    { "name": "admin", "storageState": "./states/admin.json" },
    { "name": "user", "storageState": "./states/user.json" }
  ]
}
```

Das plant 2 Rollen × 3 Seeds = 6 Läufe und führt jeweils 3 gleichzeitig aus:

```text
seeds: 1, 2, 3
runs: 6, 3 at a time
[admin/1] starting
[admin/2] starting
[admin/3] starting
…
```

- **`seeds`** ersetzt `seed`: ein Lauf je Seed und Rolle. Ohne `seeds` läuft jede Rolle einmal mit `seed`.
- **`parallel`** gibt an, wie viele Läufe gleichzeitig ausgeführt werden (Standard `1`: nacheinander). Mehr Läufe auf
  einmal brauchen mehr CPU und Speicher und belasten die Testumgebung stärker; fang mit der Zahl der CPU-Kerne an.
- `limits.maxSteps` und `limits.maxMinutes` gelten **je Lauf**.

## Ausgabe

Mit `seeds` schreibt jeder Lauf in ein eigenes Verzeichnis, und es gibt einen gemeinsamen Bericht:

```text
monkey-report/
  report.html, report.json
  admin/1/actions.json, admin/1/trace.zip, admin/1/video/, admin/1/screenshots/
  admin/2/…
  user/3/…
```

Befunde werden wie gewohnt je Lauf dedupliziert und dann über ihren Dedup-Schlüssel **über die Läufe hinweg
zusammengefasst**: Der Bericht zeigt jedes Problem einmal, mit den Rollen und Läufen, die es gefunden haben
(„found in admin, user“), und den Schritten zum Reproduzieren aus dem ersten davon. `report.json` enthält beides,
`findings[]` je Lauf und `aggregated[]`; siehe die [Referenz zum Bericht](../reference/bericht.md#reportjson). Läufe
stehen in der Reihenfolge der Konfiguration, erst die Rollen, dann die Seeds, egal, in welcher Reihenfolge sie fertig
wurden.

## Determinismus

Jeder Lauf ist so reproduzierbar wie ein einzelner: Ohne LLM führen dieselbe Konfiguration und dieselben Seeds zu
denselben Aktionen, ob die Läufe parallel oder nacheinander laufen, solange sich die Seite gleich verhält.
Läufe verschiedener Rollen auf einer Testumgebung können sich trotzdem über die gemeinsamen Daten der Seite
beeinflussen (eine Rolle löscht, was eine andere öffnet); das ist eine Eigenschaft der Seite, nicht des Monkeys. Einen
einzelnen Lauf spielst du mit seiner eigenen `<role>/<seed>/actions.json` ab.

## Fehlschläge und Exit-Code

Ein Lauf, der sich nicht anmelden kann oder abstürzt, wird im Bericht festgehalten, und die anderen laufen weiter. Der
Exit-Code ist `2`, wenn ein Lauf nicht vollständig war, sonst `1` bei Befunden, sonst `0`.

## Mit einem LLM

Alle Läufe teilen sich ein LLM: `llm.maxCalls` und `llm.maxTokens` sind Budgets für den ganzen `monkey run`, und
laufende Aufrufe zählen schon gegen `maxCalls`, sodass parallele Läufe es nicht überziehen können. Auch der Circuit
Breaker ist gemeinsam: Fehlschläge in Folge zählen über alle Läufe, und löst er aus, pausiert das LLM in jedem Lauf.
Die LLM-Tabelle im Bericht hat eine Zeile je Lauf (`admin/1`, …).
