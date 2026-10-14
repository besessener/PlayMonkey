# Das LLM

Der Zufalls-Monkey mit Seed ist gut darin, auf eine Seite einzuhämmern, und schlecht darin, an Hindernissen
vorbeizukommen: ein Consent-Banner, ein Dialog, ein Formular, das eine gültige IBAN verlangt, eine abgelaufene
Sitzung. Nur dann wird das LLM gefragt, für wenige Entscheidungen. So bleiben Läufe günstig und schnell, und ein
Ausfall des LLM hält nie einen Lauf an. Ohne `llm` in der Konfiguration ist die Schleife genau der Zufalls-Monkey.

## Ein Schritt mit LLM

```text
snapshot -> stuck? --no--> monkey chooses
               |
              yes -> LLM chooses (up to maxDecisions in a row, then cooldown)
                       | invalid answer: ask once more
                       | still failing: monkey chooses this step
               v
execute -> oracles -> action log (source "monkey" or "llm")
```

Das LLM sieht einen [serialisierten Snapshot](snapshot.md#serialisieren-für-das-llm) innerhalb von
`llm.snapshotChars`, die letzten `llm.historyActions` Aktionen mit ihren Ergebnissen, die bisherigen Befunde, warum es
gerufen wurde, die Rolle und die Platzhalter, die es verwenden darf. Befunde und der Grund stammen aus Seitentext wie
Konsolenmeldungen oder Dialognamen: Jeder wird auf seine erste Zeile mit höchstens 200 Zeichen gekürzt, damit er
keinen eigenen Abschnitt in den Prompt schreiben kann, und von den Befunden kommen nur die neuesten mit, höchstens 20
mit zusammen 2000 Zeichen. Es antwortet mit genau einem Tool-Aufruf; jede
Aktion ist ein Tool (`click`, `dblclick`, `hover`, `fill`, `select`, `check`, `uncheck`, `press`, `scroll`, `back`,
`navigate`), dazu `done`, um die Kontrolle früher zurückzugeben. Native Dialoge und Dateiauswahlen werden automatisch
beantwortet, auch während der Schritte des LLM; der Prompt sagt das.

Nichts, was es zurückgibt, gilt als vertrauenswürdig. Die Tool-Eingabe wird gegen das JSON-Schema des Tools
validiert, Element-Tools müssen eine Ref des aktuellen Snapshots nennen, und `navigate` muss auf der Seite bleiben,
wenn `stayOnDomain` an ist, und im `scope` liegen. Ein Verstoß zählt als ungültige Antwort.

## Wann der Monkey übergibt

Die Erkennung des Feststeckens läuft vor jeder Entscheidung des Monkeys; der erste Auslöser, der zutrifft, startet
eine Übergabe. Die Schwellen stehen unter `llm.handoff`.

| Auslöser | Greift, wenn |
| --- | --- |
| `blockingUi` | Ein Dialog (`role=dialog` oder `alertdialog`, auch ein offenes `<dialog>`) offen ist oder die Seite Cookies oder Consent erwähnt und einen Button wie „Accept“ oder „Reject“ hat. |
| `loginWall` | Eine angemeldete Rolle auf ihrer `loginUrl` landet oder auf einer Seite mit Passwortfeld und einem Button „Log in“ oder „Sign in“: Die Sitzung ist vermutlich abgelaufen. Greift einmal pro Ankunft. Unabhängig davon meldet PlayMonkey die Rolle selbst wieder an (siehe [Sitzungen](sitzungen.md#verlorene-sitzung)). |
| `invalidForm` | `invalidForm` Absendungen in Folge (ein Button-Klick oder Enter auf einer Seite mit Formular) auf demselben Pfad mit einem Validierungstext wie „required“ oder „please enter a valid …“ enden. |
| `failedActions` | Die letzten `failedActions` Aktionen des Monkeys alle fehlgeschlagen sind (Elemente wurden nie bedienbar, Timeouts). |
| `noStateChange` | Sich die Seite `noStateChange` Schritte lang überhaupt nicht verändert hat. |
| `noProgress` | `noProgress` Schritte lang kein neuer Zustand (URL, Snapshot-Hash) gefunden wurde. |

Eine Übergabe gibt dem LLM bis zu `maxDecisions` Entscheidungen in Folge; `done` beendet sie früher. Danach hat der
Monkey mindestens `cooldownSteps` Schritte bis zur nächsten Übergabe, und die Zähler beginnen von vorn.

## Fallback und Circuit Breaker

- **Schlechte Antwort** (Text statt Tool-Aufruf, ein ungültiger Tool-Aufruf, eine Verweigerung, eine bei
  `maxOutputTokens` abgeschnittene Antwort): Es wird einmal mit derselben Eingabe nachgefragt, dann wählt der Monkey
  diesen Schritt.
- **Transport- und HTTP-Fehler:** Das SDK wiederholt bei Rate Limits (429), Serverfehlern und Verbindungsproblemen mit
  exponentiellem Backoff (`llm.maxRetries`); andere Fehler wie 400 oder 401 schlagen sofort fehl. Dann wählt der
  Monkey.
- **Zeitlimit:** Eine Anfrage an das LLM hat insgesamt `llm.timeoutMs`, einschließlich der Wiederholungen des SDK und
  des Lesens der Antwort; das gilt auch für die Vorabprüfung. Was dann noch läuft, wird abgebrochen und zählt als
  `timeout`, sodass auch ein Endpunkt, der nie antwortet, den Lauf pro Anfrage höchstens `timeoutMs` aufhält. Das
  Zeitlimit endet spätestens mit `limits.maxMinutes` des Laufs, und Strg+C bricht eine laufende Anfrage sofort ab;
  ein solcher Abbruch, weil der Lauf endet, zählt nicht als Fehler des LLM.
- **Ausfall:** Nach `llm.breaker.failures` fehlgeschlagenen Entscheidungen in Folge wird das LLM für
  `llm.breaker.pauseSteps` Schritte pausiert und danach wieder versucht. Ein `timeout` oder ein nicht erreichbarer
  Endpunkt (`unreachable`) pausiert es schon beim ersten Mal: Jeder weitere Versuch würde wieder das volle Zeitlimit
  kosten. Den Breaker teilen sich alle Läufe eines `monkey run`: Fehlschläge zählen über Läufe hinweg, und ein
  Auslösen pausiert das LLM in jedem Lauf für `pauseSteps` seiner eigenen Schritte, damit
  [parallele Läufe](../how-to/parallel-ausfuehren.md) nicht weiter auf einen ausgefallenen Endpunkt einhämmern.
- **Budget:** Sobald `llm.maxCalls` oder `llm.maxTokens` erreicht ist, ist der Rest des Laufs (alle verbleibenden
  Rollen und Seeds, auch die parallel laufenden) reiner Monkey. Ein Aufruf zählt ab seinem Start gegen `maxCalls`,
  sodass parallele Läufe das Budget nicht überziehen können; Tokens sind erst danach bekannt, deshalb können bereits
  laufende Aufrufe `maxTokens` um ihren eigenen Verbrauch überschreiten.

Jede Übergabe, jeder Fallback, jedes Auslösen des Breakers und das Ende des Budgets werden auf der Konsole
protokolliert und im [Bericht](../reference/bericht.md#llm) gezählt.

## Secrets und Platzhalter

Secrets gelangen nie in einen Prompt:

- Die Anmeldefelder der eigenen Rolle und die Testdaten werden als Platzhalter angeboten, `{{<role>.<field>}}`
  (z. B. `{{admin.password}}`) und `{{testData.<key>}}`, nie als Werte. Das Modell schreibt den Platzhalter;
  PlayMonkey setzt den Wert erst ein, nachdem das Modell geantwortet hat, direkt vor dem Tippen, und nur in getippte
  und ausgewählte Werte, nie in die Adresse von `navigate`.
- Jedes Secret, das in der Seite, einer URL oder dem Verlauf auftaucht, auch URL-kodiert oder in einem JSON-String,
  wird vor dem Senden durch `{{env.VAR}}` ersetzt, bevor der Snapshot oder eine Aktion für den Prompt gekürzt wird,
  damit kein halbes Secret übrig bleibt.
- Eingesetzt wird nur, was das Modell gezeigt bekam: die angebotenen Platzhalter und ein `{{env.VAR}}`, das in einem
  Prompt stand und für einen Wert steht, den die Rolle ohnehin tippen darf. Den API-Key von `llm.apiKey` und die
  Zugangsdaten anderer Rollen setzt PlayMonkey nie ein, was auch immer eine Seite dem Modell zu tippen aufträgt.
- Das Aktionsprotokoll speichert wie üblich, was mit dem Platzhalter `${VAR}` getippt wurde, damit
  [Replay](replay.md) ohne LLM funktioniert.

Prompts und Antworten werden nicht gespeichert, außer `llm.debugLog` ist an, und dann noch einmal maskiert.

## Prompt-Caching

System-Prompt und Tool-Definitionen sind für jeden Aufruf eines Laufs gleich und kommen zuerst; Snapshot und Verlauf
ändern sich und kommen zuletzt. Backends mit Prompt-Caching markieren den stabilen Teil als cachebar (Anthropic:
`cache_control` am System-Prompt, was die Tools mit cacht; OpenAI cacht lange identische Präfixe automatisch).
Cache-Lesezugriffe erscheinen als `cachedTokens`. Sehr kurze Prompts können unter der minimalen cachebaren Länge
eines Modells liegen und werden dann einfach nicht gecacht.

## Ein Backend hinzufügen

Ein Backend implementiert `LlmProvider` aus `src/llm/provider.ts`:

```ts
interface LlmProvider {
  readonly name: string;
  preflight(): Promise<PreflightResult>; // one probe that must come back as a `ping` tool call; never throws
  decide(input: DecideInput, options?: DecideOptions): Promise<DecideResult>; // throws LlmError on any failure
}
```

- Deklariere die gemeinsamen `ACTION_TOOLS` (und `PING_TOOL` für die Vorabprüfung) aus `src/llm/tools.ts` im
  Tool-Format des Anbieters, sende `SYSTEM_PROMPT` und `buildUserMessage(input)` aus `src/llm/prompt.ts`, stabile
  Teile zuerst.
- Erzwinge keine Tool-Wahl: Manche Modelle lehnen das ab. Der Prompt verlangt genau einen Tool-Aufruf.
- Mach aus dem ersten Tool-Aufruf mit `parseToolCall(name, input, input.refs)` eine Entscheidung; das validiert ihn.
- Gib `options.signal` als Request-Option an das SDK weiter, damit Zeitlimit und Strg+C die Anfrage samt ihren
  Wiederholungen abbrechen.
- Bilde Fehler auf einen `LlmError` mit einer Art ab (`auth`, `notFound`, `rateLimited`, `invalid`, …; siehe
  `LlmErrorKind`) und behalte den Verbrauch fehlgeschlagener Aufrufe; die Hinweise der Vorabprüfung und der Bericht
  sind nach Art geordnet.
- Melde `usage` (Eingabe-, Ausgabe-, Cache-Lese- und Cache-Schreib-Tokens) und wie viele Anfragen wiederholt wurden.
  Die vier Zahlen überschneiden sich nicht: Zählt der Anbieter Cache-Zugriffe in den Eingabe-Tokens mit, zieh sie
  davon ab.
- Trage den Namen in `LLM_PROVIDERS` in `src/config/values.ts` und in `createProvider` in `src/llm/factory.ts` ein.

`test/helpers/fake-provider.ts` ist ein geskripteter Anbieter für Tests; `test/foundry.test.ts` und
`test/openai.test.ts` zeigen, wie man ein Backend mit gemockter HTTP-Schicht testet. Trage das neue Backend in
`test/provider-conformance.test.ts` ein: Es führt dieselben Gespräche (gültige und ungültige Tool-Aufrufe, nur Text,
Wiederholungen, Fehler, Vorabprüfung) gegen jedes Backend.

## Backends

| Anbieter | SDK | API |
| --- | --- | --- |
| `anthropic-foundry` | `@anthropic-ai/foundry-sdk` | Anthropic Messages API auf Foundry (`…/anthropic/v1/messages`) |
| `openai` | `openai` | Responses API (Standard) oder Chat Completions auf jeder OpenAI-kompatiblen Basis-URL |

Beide bilden die typisierten Fehler ihres SDK über `src/llm/sdk-errors.ts` ab, sodass Wiederholungen, Fehlerarten und
die Hinweise der Vorabprüfung sich gleich verhalten.
