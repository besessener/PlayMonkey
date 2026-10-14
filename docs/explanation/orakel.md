# Orakel und Befunde

Nach jedem Schritt des [Monkeys](monkey.md) entscheiden die Orakel, ob etwas schiefgegangen ist. Jedes Problem wird
zu einem **Befund**, dedupliziert, sodass ein Fehler, der fünfzigmal getroffen wird, einmal gemeldet wird, mit genug
Kontext, um ihn zu reproduzieren. Der Code liegt in `src/oracles/`.

## Die Orakel

| Orakel | Signal | Schweregrad |
| --- | --- | --- |
| `pageerror` | Nicht abgefangene Exception in einer Seite (`page.on('pageerror')`). | high |
| `console` | Meldung über `console.error` (`page.on('console')`, Typ `error`). | medium |
| `http5xx` | Antwort mit Status 500 … 599 (`page.on('response')`), jeder Ressourcentyp. | high |
| `http4xx` | Antwort mit Status 400 … 499, außer `findings.ignoreStatus`. | medium für die Seite selbst, low für Subressourcen und API-Aufrufe |
| `crash` | Der Renderer der Seite ist abgestürzt (`page.on('crash')`). | critical |
| `hang` | Eine Navigation oder das Laden einer Seite hat `monkey.actionTimeoutMs` überschritten, oder die Seite hat auf ein triviales Skript nicht mehr geantwortet. | high |
| `errorPage` | Eine Navigation ist auf einer Fehlerseite gelandet (siehe unten). | medium |
| `overflow` | Horizontaler Overflow: Die `scrollWidth` des Dokuments ist größer als seine `clientWidth`. | low |
| `download` | Ein Download, den die Seite gestartet hat, ist fehlgeschlagen, z. B. weil die Verbindung mitten in der Datei abgebrochen ist (`download.failure()`). | medium |
| `accessibility` | Ein Verstoß gegen eine Regel von WCAG 2.0 oder 2.1, Stufe A oder AA, laut axe-core; siehe [Barrierefreiheit](#barrierefreiheit). Standardmäßig aus. | medium bei Auswirkung `serious` und `critical`, sonst low |

Jedes lässt sich mit `oracles.<name>: false` in der [Konfiguration](../reference/konfiguration.md) abschalten;
`accessibility` schaltest du mit `oracles.accessibility: true` ein.

Die Event-Orakel (`pageerror`, `console`, `http*`, `crash`) lauschen auf jeder Seite des Browserkontexts der Rolle,
auch auf Tabs und Popups, die die Seite öffnet, und den Iframes darin. `download` sieht sich die Downloads jedes
Schritts an (siehe [den Monkey](monkey.md#seiten-die-etwas-wissen-wollen)). Die Zustands-Orakel (`hang`,
`errorPage`, `overflow`) sehen sich nach jedem Schritt die Seite an, auf der der Monkey ist, mit einer
Skriptauswertung pro Schritt.

### Was kein Befund ist

- **Eine fehlgeschlagene Aktion.** Ein Element, das verdeckt ist, verschwunden ist oder nie klickbar wird, läuft in
  einen Timeout, aber das ist das Problem des Monkeys, nicht das der Seite. Nur Timeouts beim Warten auf eine
  Navigation oder das Laden einer Seite zählen als `hang`.
- **Das Echo von Chromium auf eine fehlgeschlagene Antwort**
  (`Failed to load resource: the server responded with a status of 404`) in der Konsole. Die Antwort selbst ist der
  Befund der HTTP-Orakel; das Echo würde sie doppelt melden. Ebenso das Echo einer Anfrage, die nur deshalb
  scheitert, weil die Aktion [`offline`](monkey.md#netzwerk) das Netz gekappt hat
  (`net::ERR_INTERNET_DISCONNECTED`). Was die Seite selbst dann tut, etwa eine nicht abgefangene Ablehnung von
  `fetch`, ist sehr wohl ein Befund.
- **Eine Fehlerseite, deren Status die HTTP-Orakel melden.** Eine 404-Seite ist ein Befund `http4xx`, nicht auch noch
  `errorPage`. `errorPage` deckt ab, was die HTTP-Orakel nicht sehen können: weiche Fehlerseiten, die mit Status 200
  ausgeliefert werden und deren Titel oder Hauptüberschrift „Not found“, „Something went wrong“, „Internal Server
  Error“, „Error 500“ und Ähnliches sagt; und fehlgeschlagene Seiten, deren HTTP-Orakel abgeschaltet ist.
- **Navigationen zu anderen Domains**, die `stayOnDomain` blockiert: Sie werden als Sitzungs-Events protokolliert,
  siehe [Sitzungen](sitzungen.md).

## Befundmodell

| Feld | Bedeutung |
| --- | --- |
| `id` | `F1`, `F2`, … in der Reihenfolge der Entdeckung innerhalb einer Rolle. |
| `oracle`, `severity` | Wie in der Tabelle oben. |
| `key` | Dedup-Schlüssel, siehe unten. |
| `message` | Eine Zeile, z. B. `GET /missing-page responded 404 Not Found`. |
| `url` | Die Seite, auf der der Monkey war, als der Befund erkannt wurde. |
| `step` | Der Schritt, nach dem er erkannt wurde; Signale, die eintreffen, während ein Schritt läuft, gehören zu diesem Schritt. |
| `role` | Die Rolle, die ihn gefunden hat. |
| `occurrences` | Wie oft derselbe Schlüssel gesehen wurde. |
| `details` | Orakelspezifisch: Methode, Request-URL, Status und Ressourcentyp bei HTTP; der Stack bei `pageerror`; die Fundstelle in der Konsole; Breiten und das verursachende Element bei `overflow`. |
| `lastActions` | Die letzten `findings.lastActions` Aktionen (Standard 10) bis einschließlich `step`, jede mit ihrem dauerhaften Locator: der Weg zum Fehler. |
| `screenshotPath` | Ein Screenshot direkt nach der Erkennung, in `<report.dir>/<role>/screenshots/`. Fehlt bei abgestürzten oder hängenden Seiten. |

Alles in einem Befund außer dem Screenshot-Pfad durchläuft die [Maskierung von Secrets](grundregeln.md), weil Seiten
wiedergeben können, was in sie eingetippt wurde.

## Deduplizierung

Jedes Signal bekommt einen Schlüssel. Ein schon gesehener Schlüssel erhöht `occurrences` des ersten Befunds; der
Befund behält den Kontext (Schritt, Screenshot, letzte Aktionen) seines **ersten** Auftretens, das meist der kürzeste
Weg dorthin ist.

| Orakel | Schlüssel |
| --- | --- |
| `pageerror` | Normalisierte Meldung + erster Stack-Frame (mit Zeile und Spalte: Dieselbe Meldung von zwei Stellen sind zwei Fehler). |
| `console` | Normalisierte Meldung. |
| `http4xx`, `http5xx` | Methode + normalisierte URL + Status. |
| `overflow` | Normalisierte Seiten-URL + das verursachende Element (das äußerste Element, das rechts herausragt, z. B. `div.banner`). |
| `errorPage` | Normalisierte Seiten-URL + Status. |
| `hang` | Art (`navigation` oder `unresponsive`) + normalisierte URL. |
| `crash` | Normalisierte Seiten-URL. |
| `download` | Normalisierte Download-URL. |
| `accessibility` | Regel (z. B. `image-alt`) + normalisierte Seiten-URL. |

Die **Normalisierung** entfernt, was sich zwischen Auftreten desselben Fehlers ändert:

- URLs verlieren Query und Fragment; numerische Pfadsegmente werden zu `:n`, UUIDs, Hex-IDs und lange Tokens zu
  `:id` (`/orders/4711/items/9?x=1` → `/orders/:n/items/:n`). Der eigene Origin der Seite fällt weg, sodass Schlüssel
  gleich bleiben, wenn die Testumgebung auf einen anderen Host oder Port umzieht, zum Beispiel zwischen einem Lauf und
  seinem Replay.
- Meldungen werden für URLs darin genauso behandelt; andere Zahlen werden zu `#`, IDs zu `:id`, und Leerraum wird
  zusammengefasst.

Ein Overflow wird nach seinem Verursacher geschlüsselt, nicht nach der Viewport-Größe: Ein zu breites Element läuft
in Smartphone-, Tablet- und Laptop-Viewports gleichermaßen über und ist ein Fehler. Overflows, die von verschiedenen
Elementen an verschiedenen Breakpoints verursacht werden, bleiben getrennt. Bleibt der Monkey auf einer überlaufenden
Seite, zählt das einmal pro Besuch, nicht einmal pro Schritt.

## Ignorierregeln

Bekanntes Rauschen, etwa ein Widget eines Drittanbieters, das Fehler protokolliert, wird mit `findings.ignore`
verworfen:

```json
"findings": {
  "ignoreStatus": [401],
  "ignore": [
    { "oracle": "console", "message": "^\\[analytics\\]" },
    { "url": "^https://widgets\\.example\\.com/" }
  ]
}
```

Eine Regel greift, wenn jeder Teil passt, den sie setzt: `oracle` exakt, `url` und `message` als reguläre Ausdrücke
von JavaScript (Groß- und Kleinschreibung beachtet) gegen die Request-URL (HTTP-Befunde) oder die Seiten-URL (alle
anderen) und die Meldung des Befunds. `findings.ignoreStatus` listet HTTP-Status, die nie Befunde sind; ein 401 von
einer API, von der die Seite erwartet, dass sie fehlschlägt, ist ein typischer.

## Barrierefreiheit

Mit `oracles.accessibility: true` prüft [axe-core](https://github.com/dequelabs/axe-core) jede Seite eines Laufs
**einmal**, nach ihrer normalisierten URL (`/orders/17` und `/orders/18` sind eine Seite), gleich nach dem ersten
Schritt, der auf ihr endet. Geprüft werden die Regeln mit den Tags `wcag2a`, `wcag2aa`, `wcag21a` und `wcag21aa`; die
„Best Practices“ von axe bleiben draußen. Jede verletzte Regel ergibt pro Seite einen Befund, mit bis zu fünf
betroffenen Elementen (CSS-Selektoren), der Auswirkung und dem Link zur Erklärung in `details`.

Das Orakel ist standardmäßig aus: Die meisten Seiten haben viele solche Verstöße, und eine Prüfung kostet pro Seite
einige hundert Millisekunden. Geprüft wird das Hauptdokument, nicht der Inhalt von Iframes. axe wird über das
DevTools-Protokoll in die Seite gebracht, eine strenge Content-Security-Policy hält es also nicht auf. Scheitert eine
Prüfung oder dauert sie länger als das Vierfache von `monkey.actionTimeoutMs`, versucht der nächste Besuch der Seite
es noch einmal; eine gescheiterte Prüfung ist kein Befund. Einzelne Regeln verwirfst du mit einer Ignorierregel, etwa
`{ "oracle": "accessibility", "message": "^color-contrast " }`.

## Abstürze

Eine abgestürzte Seite wirft bei jedem Aufruf. Der Monkey schließt sie und macht in einem anderen Tab weiter oder in
einer frischen Seite auf `baseUrl`, sodass ein Absturz den Lauf nicht beendet.

## Ein Orakel hinzufügen

Orakel liegen in `src/oracles/oracles.ts`; jedes erzeugt Signale über `#add(oracle, signal)`, das die Ignorierregeln
anwendet und nach Schlüssel dedupliziert.

1. Trage den Namen in `ORACLES` in `src/config/values.ts` und seinen Standardwert in `DEFAULTS.oracles` in
   `src/config/defaults.ts` ein. Das macht `oracles.<name>` zu einem Konfigurationsschlüssel; dokumentiere ihn in der
   [Konfiguration](../reference/konfiguration.md), was `test/docs.test.ts` erzwingt.
2. Erkenne das Problem in der Klasse `Oracles`: Ein **Event-Orakel** registriert einen Listener in `#watch(page)`, das
   für jede Seite des Kontexts läuft, Popups eingeschlossen; ein **Zustands-Orakel** prüft die Seite nach jedem
   Schritt in `#inspect(page, navigated)`; was in den Events des Schritts festgehalten ist, gehört in `check`. Kehre
   früh zurück, wenn `this.#config.oracles.<name>` aus ist.
3. Rufe `this.#add("<name>", { severity, key, message, url, details })` auf. Bilde den **Schlüssel** aus dem, was den
   Fehler identifiziert und über Auftreten, Läufe und Replay gleich bleibt: Verwende `normalizeUrl` und
   `normalizeMessage` aus `src/oracles/keys.ts` und nie den Schritt, einen Zeitstempel oder den Port. Halte die
   Meldung kurz; der Rest gehört in `details`.
4. Füge der [Fixture-Seite](../how-to/fixture-seite-nutzen.md) eine Seite mit dem Fehler hinzu und in
   `test/oracles.test.ts` einen Test, dass das Orakel ihn genau einmal meldet und auf einer sauberen Seite nicht
   anschlägt.

Alles andere folgt von selbst: Der Befund bekommt eine ID, die letzten Aktionen und einen Screenshot, kommt für
Replay ins Aktionsprotokoll, in beide Berichte und wird über [parallele Läufe](../how-to/parallel-ausfuehren.md)
hinweg zusammengefasst.
