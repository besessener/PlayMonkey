# Aktionsprotokoll (`actions.json`)

`monkey run` schreibt pro Rolle ein Aktionsprotokoll nach `<report.dir>/<role>/actions.json`. Es listet jede
ausgeführte Aktion in ihrer Reihenfolge, damit `monkey replay` den Lauf ohne Zufall und ohne LLM wiederholen kann.
Die Datei wird nach jedem Schritt neu geschrieben (in eine temporäre Datei, die dann umbenannt wird), sie ist also
immer vollständiges JSON, auch wenn ein Lauf abgebrochen wird.

## Beispiel

```json
{
  "version": 2,
  "seed": 42,
  "baseUrl": "${FIXTURE_URL}",
  "role": "user",
  "viewport": [1280, 800],
  "placeholders": ["CONTACT_NAME", "FIXTURE_PASS", "FIXTURE_URL", "FIXTURE_USER"],
  "actions": [
    {
      "step": 1,
      "source": "monkey",
      "type": "click",
      "ref": "e16",
      "locator": "getByRole('link', { name: 'Console error' })",
      "pageUrl": "${FIXTURE_URL}/",
      "snapshotHash": "1c62b404aedd1ffc",
      "ok": true
    },
    {
      "step": 7,
      "source": "monkey",
      "type": "fill",
      "ref": "e8",
      "value": "${CONTACT_NAME}",
      "locator": "getByRole('textbox', { name: 'Name' })",
      "pageUrl": "${FIXTURE_URL}/form",
      "snapshotHash": "6f0c3b1e9d2a4c57",
      "ok": true
    },
    {
      "step": 12,
      "source": "monkey",
      "type": "click",
      "ref": "e11",
      "locator": "getByRole('button', { name: 'Delete everything' })",
      "pageUrl": "${FIXTURE_URL}/lab/dialogs",
      "snapshotHash": "0b5e2d7a91c4f3e8",
      "ok": true,
      "events": [{ "kind": "dialog", "dialog": "confirm", "message": "Really delete everything?", "accepted": false }]
    }
  ],
  "findings": [
    { "id": "F1", "oracle": "console", "severity": "medium", "key": "console|Seeded bug: console error on load", "message": "Seeded bug: console error on load", "step": 1 }
  ]
}
```

## Felder

| Feld | Bedeutung |
| --- | --- |
| `version` | Formatversion, derzeit `2`. Protokolle der Version 1 (vor den Aktionen `dblclick`, `rightclick`, `hover`, `longPress`, `drag` und `events`) werden weiterhin gelesen; andere Versionen lehnt `monkey replay` mit einer klaren Meldung ab. |
| `seed`, `baseUrl`, `role`, `viewport` | Die Einstellungen des Laufs; Replay nutzt sie statt der aus der Konfiguration. |
| `placeholders` | Variablen, deren Werte das Protokoll als `${VAR}` speichert; siehe unten. |
| `actions[].step` | 1, 2, … in Ausführungsreihenfolge. |
| `actions[].source` | `monkey`, oder `llm` für eine Aktion, die das LLM gewählt hat. Replay führt beide gleich aus. |
| `actions[].type` und seine Felder | Die Aktion: `click`, `dblclick`, `rightclick`, `hover`, `longPress`, `check`, `uncheck` (`ref`); `drag` (`ref`, `toRef`); `fill`, `select` (`ref`, `value`); `press` (`key`); `scroll` (`deltaY`); `back`; `navigate` (`url`); `setViewport` (`width`, `height`); `switchTab` (`index`). |
| `actions[].ref` | Die Ref des Elements im Snapshot dieses Schritts. Nur zur Information: Refs überleben keinen Seitenwechsel. |
| `actions[].locator` | **Dauerhafter Locator** des Elements, so wie Playwrights `codegen` ihn schreibt. Replay findet das Element darüber. |
| `actions[].toLocator` | Nur bei `drag`: dauerhafter Locator des Ablageziels. |
| `actions[].events` | Was die Seite während des Schritts verlangt oder ausgegeben hat, in Reihenfolge: `{ "kind": "dialog", "dialog", "message", "accepted", "text"? }` (`text`: was in einen Prompt getippt wurde), `{ "kind": "upload", "files": [names] }` (erzeugte Dateien, siehe [den Monkey](../explanation/monkey.md#seiten-die-etwas-wissen-wollen)) und `{ "kind": "download", "name", "url", "size"? , "failure"? }`. Replay beantwortet Dialoge und Dateiauswahlen genauso. Fehlt, wenn nichts passiert ist. |
| `actions[].pageUrl`, `snapshotHash` | Der Zustand, in dem die Aktion gewählt wurde. |
| `actions[].ok`, `error` | Ob die Aktion gelungen ist, und wenn nicht, warum. Eine fehlgeschlagene Aktion wird trotzdem wiederholt. |
| `findings` | Die Befunde des Laufs (Id, Orakel, Schweregrad, Dedup-Schlüssel, Meldung, Schritt), mit denen Replay vergleicht. |

## Secrets und Platzhalter

Jeder Wert, der aus einem `${VAR}`-Platzhalter in der Konfiguration stammt (Passwörter, die Basis-URL der
Testumgebung, Testdaten), wird in den Freitextfeldern des Protokolls wieder als Platzhalter geschrieben (`baseUrl`,
`role`, `value`, `url`, `key`, `locator`, `toLocator`, `pageUrl`, `error`, Dialogmeldungen und Prompt-Text, Namen
und URLs von Downloads, Meldungen und Schlüssel von Befunden). `monkey replay` löst sie wieder aus der Umgebung auf
und bricht mit dem Namen der Variable ab, wenn eine nicht gesetzt ist.

Das Protokoll enthält also keine geheimen Werte, und dasselbe Protokoll lässt sich gegen einen anderen Host oder Port
wiederholen, wenn sich nur die Variable ändert. Passwörter, die bei der Anmeldung eingetippt werden, landen überhaupt
nicht im Protokoll: Die Anmeldung läuft vor dem Monkey, in einem eigenen Kontext.
