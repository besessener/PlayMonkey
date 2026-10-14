# Konfiguration

`monkey run <config.json>` liest eine JSON-Datei. Das Schema, mit denselben Beschreibungen und Standardwerten, ist
`src/config/schema.ts` (der Abschnitt `llm` in `src/config/llm-schema.ts`); `test/docs.test.ts` schlägt fehl, wenn
dort ein Schlüssel steht, der auf dieser Seite fehlt.

## Beispiel

```json
{
  "baseUrl": "https://test.example.org",
  "seed": 42,
  "limits": { "maxSteps": 500, "maxMinutes": 20 },
  "browser": { "engine": "chromium", "viewport": [1280, 800], "headless": true },
  "stayOnDomain": true,
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    },
    { "name": "user", "storageState": "./states/user.json" }
  ],
  "testData": { "email": "monkey@test.local" },
  "llm": {
    "provider": "anthropic-foundry",
    "baseUrl": "https://<resource>.services.ai.azure.com/anthropic",
    "deployment": "<deployment-name>",
    "apiKey": "${FOUNDRY_API_KEY}",
    "maxCalls": 200,
    "pricing": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3 }
  },
  "oracles": { "overflow": false },
  "findings": { "lastActions": 10, "ignoreStatus": [401], "ignore": [{ "oracle": "console", "message": "^\\[analytics\\]" }] },
  "report": { "dir": "./monkey-report" }
}
```

## Schlüssel

| Schlüssel | Typ | Standard | Bedeutung |
| --- | --- | --- | --- |
| `$schema` | string | – | Optionaler Verweis auf ein JSON Schema für Editoren; wird ignoriert. |
| `baseUrl` | string, Pflicht | – | Absolute `http(s)`-URL der getesteten Seite. |
| `seed` | integer 0 … 4294967295 | zufällig, wird ausgegeben | Seed des Zufalls-Monkeys. Setze ihn, um einen Lauf zu reproduzieren. |
| `seeds` | Array unterschiedlicher Integer 0 … 4294967295, mindestens einer | fehlt | Ein Lauf pro Seed und Rolle statt `seed`; jeder Lauf schreibt nach `<role>/<seed>/` im Berichtsverzeichnis. Siehe [parallel ausführen](../how-to/parallel-ausfuehren.md). |
| `parallel` | integer 1 … 64 | `1` | Läufe (Rollen × Seeds), die gleichzeitig laufen, jeder in einem eigenen Browserkontext desselben Browsers. `1` führt sie nacheinander aus. |
| `limits.maxSteps` | integer ≥ 1 | `500` | Höchstzahl an Aktionen pro Lauf (Rolle und Seed). |
| `limits.maxMinutes` | number > 0 | `20` | Höchstdauer pro Lauf (Rolle und Seed) in Minuten echter Zeit. |
| `browser.engine` | `chromium` \| `firefox` \| `webkit` | `chromium` | Browser-Engine von Playwright. |
| `browser.viewport` | `[width, height]`, Integer ≥ 1 | `[1280, 800]` | Viewport in CSS-Pixeln. |
| `browser.headless` | boolean | `true` | Den Browser ohne Fenster ausführen. |
| `stayOnDomain` | boolean | `true` | Navigationen zu anderen Origins als dem von `baseUrl` nicht folgen. |
| `scope.allow` | Array regulärer Ausdrücke | `[]` | Ist es nicht leer, öffnet der Monkey nur Seiten, deren vollständige URL zu einem der Muster passt; siehe [scope](../explanation/sitzungen.md#scope). |
| `scope.deny` | Array regulärer Ausdrücke | `[]` | Seiten, deren vollständige URL zu einem der Muster passt, öffnet der Monkey nie, z. B. `["/logout", "/admin/"]`. |
| `network.latencyMs` | integer 0 … 60000 | `0` | Verzögerung jeder Anfrage des Laufs in Millisekunden; siehe [Netzwerk](../explanation/monkey.md#netzwerk). |
| `auth` | Array | `[]` (eine anonyme Rolle) | Rollen, unter denen gelaufen wird; siehe unten. |
| `auth[].name` | string, Pflicht | – | Eindeutiger Rollenname. |
| `auth[].loginUrl` | string | – | Pfad der Anmeldeseite, relativ zu `baseUrl`. Pflicht mit `fields`. |
| `auth[].fields` | Objekt aus Strings | – | Felder des Anmeldeformulars, die ausgefüllt werden: Schlüssel → Wert. |
| `auth[].submit` | string | – | Selektor des Absende-Buttons der Anmeldung. Pflicht mit `fields`. |
| `auth[].storageState` | string | – | Storage-State-Datei von Playwright, relativ zur Konfigurationsdatei. |
| `testData` | Objekt aus Strings | `{}` | Gültige Werte, die der Monkey beim Ausfüllen von Feldern nutzen darf (Schlüssel frei wählbar). |
| `llm` | Objekt | fehlt | LLM, das genutzt wird, wenn der Monkey feststeckt. Fehlt es, läuft der reine Zufalls-Monkey. |
| `llm.provider` | `anthropic-foundry` \| `openai` | – | Backend. Pflicht in `llm`. |
| `llm.baseUrl` | string | – | Basis-URL des Endpunkts: bis einschließlich `/anthropic` für `anthropic-foundry`, die vollständige OpenAI-kompatible Basis-URL (z. B. `…/openai/v1`) für `openai`. Pflicht in `llm`. |
| `llm.deployment` | string | – | Name des Deployments, wird als Modell genutzt. Pflicht in `llm`. |
| `llm.apiKey` | string | – | API-Key; nutze einen `${VAR}`-Platzhalter. Pflicht in `llm`. |
| `llm.required` | boolean | `true` | Ein fehlgeschlagener [Preflight](../how-to/llm-einrichten.md#fehlerbehebung) endet mit Code `2`; `false` warnt und läuft als reiner Zufalls-Monkey. |
| `llm.timeoutMs` | integer ≥ 1000 | `60000` | Zeitlimit einer LLM-Anfrage in Millisekunden. |
| `llm.maxRetries` | integer 0 … 10 | `2` | Wiederholungen einer Anfrage nach einem Rate Limit (429), einem Server- oder Verbindungsfehler, mit exponentiellem Backoff. Andere Fehler werden nicht wiederholt. |
| `llm.maxCalls` | integer ≥ 0 | unbegrenzt | Budget: LLM-Aufrufe pro `monkey run`, über alle Rollen und Seeds, auch wenn sie parallel laufen (laufende Aufrufe zählen mit). Ist es aufgebraucht, laufen die Läufe als reiner Monkey weiter, und der Bericht sagt das. |
| `llm.maxTokens` | integer ≥ 0 | unbegrenzt | Budget: Tokens pro `monkey run`, über alle Rollen und Seeds (Eingabe, Ausgabe, Cache-Lese- und -Schreibzugriffe). Parallel bereits laufende Aufrufe können es um ihre eigenen Tokens überschreiten. |
| `llm.debugLog` | boolean | `false` | Jeden Prompt und jede Antwort bereinigt in `llm-debug.jsonl` im Berichtsverzeichnis schreiben. Aus: Kein Prompt-Inhalt wird irgendwo geschrieben. |
| `llm.historyActions` | integer ≥ 0 | `10` | Anzahl der letzten Aktionen, die das LLM zu sehen bekommt. |
| `llm.snapshotChars` | integer ≥ 500 | `8000` | Zeichenbudget des Seiten-Snapshots im Prompt (grob vier Zeichen pro Token). |
| `llm.handoff.noStateChange` | integer ≥ 1 | `5` | Übergeben nach so vielen Schritten in Folge ohne jede Änderung der Seite. |
| `llm.handoff.noProgress` | integer ≥ 1 | `25` | Übergeben nach so vielen Schritten in Folge ohne neuen Zustand (URL, Snapshot-Hash). |
| `llm.handoff.failedActions` | integer ≥ 1 | `5` | Übergeben nach so vielen fehlgeschlagenen Monkey-Aktionen in Folge. |
| `llm.handoff.invalidForm` | integer ≥ 1 | `3` | Übergeben nach so vielen Formularabsendungen in Folge, die mit Validierungsfehlern enden. |
| `llm.handoff.blockingUi` | boolean | `true` | Übergeben, wenn ein Dialog oder ein Cookie- oder Einwilligungsbanner offen ist. |
| `llm.handoff.loginWall` | boolean | `true` | Übergeben, wenn eine angemeldete Rolle auf einer Anmeldeseite landet (abgelaufene Sitzung). |
| `llm.handoff.maxDecisions` | integer ≥ 1 | `3` | Aufeinanderfolgende LLM-Entscheidungen pro Übergabe; danach übernimmt wieder der Monkey. |
| `llm.handoff.cooldownSteps` | integer ≥ 0 | `5` | Monkey-Schritte nach einer Übergabe, bevor die nächste beginnen kann. |
| `llm.breaker.failures` | integer ≥ 1 | `3` | Fehlgeschlagene LLM-Entscheidungen in Folge, über alle Läufe, die den Circuit Breaker öffnen. |
| `llm.breaker.pauseSteps` | integer ≥ 1 | `20` | Schritte ohne LLM, solange der Breaker offen ist, gezählt in den eigenen Schritten jedes Laufs; ein Auslösen pausiert jeden Lauf. |
| `llm.pricing` | Objekt | fehlt | Preise pro Million Tokens für **geschätzte** Kosten im Bericht. Es gibt keine eingebauten Preise. |
| `llm.pricing.inputPerMTok` | number ≥ 0 | – | Preis pro Million Eingabe-Tokens. Pflicht in `pricing`. |
| `llm.pricing.outputPerMTok` | number ≥ 0 | – | Preis pro Million Ausgabe-Tokens (Thinking eingeschlossen). Pflicht in `pricing`. |
| `llm.pricing.cacheReadPerMTok` | number ≥ 0 | `inputPerMTok` | Preis pro Million Tokens, die aus dem Prompt-Cache gelesen werden. |
| `llm.pricing.cacheWritePerMTok` | number ≥ 0 | `inputPerMTok` | Preis pro Million Tokens, die in den Prompt-Cache geschrieben werden. |
| `llm.options.maxOutputTokens` | integer ≥ 16 | `4096` | Limit der Ausgabe-Tokens einer Anfrage (`max_tokens`, `max_output_tokens` oder `max_completion_tokens`). Thinking- und Reasoning-Tokens zählen mit. |
| `llm.options.thinking` | `adaptive` \| `disabled` \| `between_tools` | Standard des Modells | Nur `anthropic-foundry`. Thinking-Modus, der an das Modell geschickt wird. Fehlt er, wird nichts geschickt; welche Werte ein Modell akzeptiert, ist unterschiedlich, siehe [LLM einrichten](../how-to/llm-einrichten.md#thinking-und-effort). |
| `llm.options.effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | Standard des Modells | Effort-Stufe, die an das Modell geschickt wird: Anthropics Effort, OpenAIs Reasoning Effort. |
| `llm.options.api` | `responses` \| `chat` | `responses` | Nur `openai`. Die Responses API, oder Chat Completions für Modelle, die nur das anbieten; siehe [LLM einrichten](../how-to/llm-einrichten.md#openai-modelle-und-andere-openai-kompatible-endpunkte). |
| `oracles.pageerror` | boolean | `true` | Nicht abgefangene Exceptions melden. |
| `oracles.console` | boolean | `true` | `console.error`-Meldungen melden. |
| `oracles.http5xx` | boolean | `true` | Antworten mit Status ≥ 500 melden. |
| `oracles.http4xx` | boolean | `true` | Antworten mit Status 400 … 499 melden. |
| `oracles.crash` | boolean | `true` | Abstürze der Seite oder des Browsers melden. |
| `oracles.hang` | boolean | `true` | Aktionen oder Navigationen melden, die ihr Zeitlimit überschreiten. |
| `oracles.errorPage` | boolean | `true` | Navigationen melden, die auf einer Fehlerseite landen. |
| `oracles.overflow` | boolean | `true` | Horizontalen Überlauf melden. |
| `oracles.download` | boolean | `true` | Downloads melden, die fehlschlagen (z. B. weil die Verbindung abbricht). |
| `oracles.accessibility` | boolean | `false` | Jede Seite einmal mit axe-core auf Verstöße gegen WCAG 2.1 A und AA prüfen; siehe [Barrierefreiheit](../explanation/orakel.md#barrierefreiheit). |
| `findings.lastActions` | integer ≥ 0 | `10` | Anzahl der Aktionen vor einem Befund, die er zur Reproduktion festhält. |
| `findings.ignoreStatus` | Array von Integern 400 … 599 | `[]` | HTTP-Status, die nie Befunde sind, z. B. `[401, 403]`. |
| `findings.ignore` | Array | `[]` | Regeln, die bekanntes Rauschen verwerfen; siehe [Ignorierregeln](../explanation/orakel.md#ignorierregeln). |
| `findings.ignore[].oracle` | Orakelname | alle | Nur Signale dieses Orakels. |
| `findings.ignore[].url` | regulärer Ausdruck | – | Wird gegen die Anfrage-URL (HTTP-Befunde) oder die Seiten-URL geprüft. |
| `findings.ignore[].message` | regulärer Ausdruck | – | Wird gegen die Meldung des Befunds geprüft. Jede Regel braucht `url` oder `message`. |
| `findings.baseline` | string | fehlt | `baseline.json` eines früheren Laufs, relativ zur Konfigurationsdatei. Befunde, die es auflistet, sind bekannt und lassen den Lauf nicht scheitern; siehe [Baseline](../how-to/in-ci-ausfuehren.md#nur-neue-befunde-mit-einer-baseline). |
| `report.dir` | string | `./monkey-report` | Ausgabeverzeichnis des Berichts, relativ zur Konfigurationsdatei. |
| `report.keepDownloads` | boolean | `false` | Die Dateien, die die Seite heruntergeladen hat, in `<role>/downloads/` des Berichtsverzeichnisses behalten. Aus: Sie werden vermessen (Name, Größe) und gelöscht, wenn die Rolle endet. |
| `monkey.actionTimeoutMs` | integer ≥ 100 | `5000` | Zeitlimit einer Aktion in Millisekunden; eine langsamere Aktion schlägt fehl, und der Lauf geht weiter. Auch so lange wartet ein Schritt darauf, dass Dialoge, Uploads und Downloads fertig werden. |
| `monkey.maxTabs` | integer ≥ 1 | `5` | Offene Tabs pro Rolle. Öffnen Popups mehr, werden die ältesten geschlossen, die der Monkey zurückgelassen hat (nie der erste Tab oder der aktuelle). |
| `monkey.weights.click` | number ≥ 0 | `10` | Relatives Gewicht für Klicks auf Links, Buttons und andere klickbare Elemente. |
| `monkey.weights.dblclick` | number ≥ 0 | `0.5` | Relatives Gewicht für Doppelklicks auf ein klickbares Element. |
| `monkey.weights.rightclick` | number ≥ 0 | `0.5` | Relatives Gewicht für Rechtsklicks auf ein klickbares Element (Kontextmenüs). |
| `monkey.weights.hover` | number ≥ 0 | `1` | Relatives Gewicht dafür, die Maus über ein klickbares Element zu bewegen (Hover-Menüs, Tooltips). |
| `monkey.weights.longPress` | number ≥ 0 | `0.3` | Relatives Gewicht für langes Drücken eines klickbaren Elements; nur in Viewports schmaler als 1024 px. |
| `monkey.weights.drag` | number ≥ 0 | `0.3` | Relatives Gewicht dafür, ein klickbares Element auf ein anderes Element zu ziehen (nach bestem Bemühen). |
| `monkey.weights.fill` | number ≥ 0 | `6` | Relatives Gewicht für Eingaben in Textfelder. |
| `monkey.weights.select` | number ≥ 0 | `3` | Relatives Gewicht für die Auswahl einer Option in einem Dropdown. |
| `monkey.weights.check` | number ≥ 0 | `3` | Relatives Gewicht für das Umschalten von Checkboxen, Radio-Buttons und Schaltern. |
| `monkey.weights.press` | number ≥ 0 | `1` | Relatives Gewicht für einen Tastendruck (Tab, Enter, Escape, Pfeiltasten). |
| `monkey.weights.scroll` | number ≥ 0 | `1` | Relatives Gewicht fürs Scrollen. |
| `monkey.weights.back` | number ≥ 0 | `1.5` | Relatives Gewicht für einen Schritt zurück im Verlauf. |
| `monkey.weights.navigate` | number ≥ 0 | `1` | Relatives Gewicht dafür, eine URL zu öffnen, die früher im Lauf vorkam. |
| `monkey.weights.setViewport` | number ≥ 0 | `0.2` | Relatives Gewicht für eine Änderung der Viewport-Größe. |
| `monkey.weights.switchTab` | number ≥ 0 | `1` | Relatives Gewicht für den Wechsel in einen anderen offenen Tab. |
| `monkey.weights.offline` | number ≥ 0 | `0` | Relatives Gewicht dafür, den Browser für den nächsten Schritt offline zu nehmen; siehe [Netzwerk](../explanation/monkey.md#netzwerk). |

Wie das LLM eingesetzt wird, erklärt [Das LLM](../explanation/llm.md); wie du ein Backend einrichtest, [LLM
einrichten](../how-to/llm-einrichten.md). Was jedes Orakel meldet, erklärt [Orakel und
Befunde](../explanation/orakel.md).

## Regeln

- **`seed` oder `seeds`**, nicht beides. Ohne beide wird ein zufälliger Seed erzeugt und ausgegeben.
- **Rollen in `auth`:** Jede nutzt entweder `fields` mit `loginUrl` und `submit` oder `storageState`, nie beides.
- **Unbekannte Schlüssel werden abgelehnt**, nicht nur mit einer Warnung bedacht: Ein Tippfehler wie `maxStep` fiele
  sonst stillschweigend auf einen Standardwert zurück. Nur `testData` und `auth[].fields` nehmen beliebige Schlüssel.
- **`null` wird abgelehnt**; lass einen Schlüssel weg, um seinen Standardwert zu bekommen.
- **`scope`:** Jedes Muster muss ein gültiger regulärer Ausdruck sein, und `baseUrl` muss im Scope liegen.
- **Ignorierregeln** brauchen `url` oder `message`, und beide müssen gültige reguläre Ausdrücke von JavaScript sein;
  um ein Orakel ganz abzuschalten, nutze `oracles.<name>: false`.
- **Relative Pfade** (`auth[].storageState`, `report.dir`, `findings.baseline`) werden gegen das Verzeichnis der
  Konfigurationsdatei aufgelöst.
- **Fehler** werden alle auf einmal aufgelistet, jeder mit seinem Pfad (z. B. `auth[0].fields.password`); der
  Exit-Code ist `2`.

## Secrets: `${VAR}`

`${VAR}` in einem beliebigen String-Wert wird durch die Umgebungsvariable `VAR` ersetzt, auch innerhalb längerer
Strings (`"https://${HOST}/app"`). Namen entsprechen `[A-Za-z_][A-Za-z0-9_]*`. Eingesetzte Werte werden nicht erneut
ersetzt, und es gibt keine Escape-Syntax. Eine nicht gesetzte Variable ist ein Fehler, der den Pfad in der
Konfiguration und die Variable nennt; eine leere wird als leer verwendet.

Jeder eingesetzte Wert wird in Konsolenausgabe, Fehlermeldungen und Berichten als `***` maskiert. Secrets kommen nur
aus der Umgebung, nie aus Dateien.
