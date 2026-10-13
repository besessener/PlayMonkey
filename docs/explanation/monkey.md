# Der Zufalls-Monkey

Der Monkey ist die Standardquelle für Aktionen. In jedem Schritt nimmt er einen [Snapshot](snapshot.md) auf, wählt
mit einem Zufallsgenerator mit Seed eine Aktion, führt sie aus und reicht das Ergebnis weiter. Derselbe Seed und
dieselbe Seite ergeben denselben Lauf.

## Determinismus

- **Generator:** sfc32 mit Seed über splitmix32 (`src/monkey/random.ts`), nur 32-Bit-Ganzzahlarithmetik, damit die
  Folge auf jeder Plattform gleich ist. `Math.random` wird nie verwendet. Ein Test hält die ersten Werte fest.
- **Seed:** `seed` aus der Konfiguration oder ein zufälliger, den `monkey run` ausgibt, damit du ihn in die
  Konfiguration übernehmen kannst.
- **Eingaben jeder Wahl** sind der Snapshot (Elemente in Dokumentreihenfolge), was der Lauf bisher erkundet hat, und
  der Generator. Solange die Seite gleich gerendert wird, ergibt derselbe Seed dieselbe Folge von Aktionen, Werten und
  dauerhaften Locators; ein Test führt die Fixture zweimal aus und vergleicht.
- **Antworten an die Seite** (native Dialoge, Dateiauswahlen) kommen aus einem zweiten Generator mit Seed aus
  demselben Seed, sodass sie die eigene Folge des Monkeys nie verschieben; siehe
  [Seiten, die etwas wissen wollen](#seiten-die-etwas-wissen-wollen).
- **Mit LLM** bleibt der Lauf an den Seed gebunden, aber jeder Schritt, den das LLM macht, ist einer, den der
  Generator nicht macht; deshalb weicht die Folge ab der ersten Übergabe von einem Lauf ohne `llm` ab. Bis dahin ist
  sie identisch; ein Test prüft das. Siehe [das LLM](llm.md).

## Eine Aktion wählen

1. **Aktionstyp** nach Gewicht (`monkey.weights`), unter den Typen, die auf der aktuellen Seite möglich sind: `click`
   (Links, Buttons, alles Klickbare), `dblclick`, `rightclick` und `hover` (auf denselben Elementen: Bearbeiten an Ort
   und Stelle, Kontextmenüs, Hover-Menüs), `longPress` (drücken und halten; nur in Viewports schmaler als 1024 px),
   `drag` (ein Element auf ein anderes, nach bestem Bemühen), `fill` (Textfelder), `select` (Dropdowns), `check`
   (Checkboxen, Radiobuttons, Schalter; ein angehakter wird abgehakt), `press` (Tab, Shift+Tab, Enter, Escape,
   Pfeiltasten, Leertaste: Navigation nur per Tastatur), `scroll`, `back`, `navigate` (zu einer URL, die früher im
   Lauf gesehen wurde), `setViewport` (Größen für Smartphone, Tablet, Laptop, Desktop) und `switchTab` (nur bei
   mehreren Tabs). Ein Gewicht von 0 schaltet einen Typ ab.
2. **Element** innerhalb dieses Typs, bevorzugt Neues: Das Gewicht eines Elements sinkt mit jeder Verwendung im
   selben Zustand (URL und Snapshot-Hash), und Links zu einer URL, die der Lauf noch nicht besucht hat, zählen
   dreifach. Deaktivierte Elemente werden übersprungen; mit `stayOnDomain` sind Links zu anderen Origins keine
   Kandidaten.
3. **Blockierende Oberfläche zuerst:** Solange ein Dialog offen ist, zählen die Elemente darin zehnfach; solange ein
   Cookie- oder Consent-Banner zu sehen ist, gilt das auch für seine Antwort-Buttons („Accept“, „Reject“, …). Solche
   Overlays verdecken meist die Seite, Klicks anderswo liefen also nur in einen Timeout. Der Lauf bleibt nie an einem
   hängen: Ein verdecktes Element scheitert nach `monkey.actionTimeoutMs`, und mit LLM ist der offene Dialog auch ein
   Auslöser für eine [Übergabe](llm.md#wann-der-monkey-übergibt).

## Werte für Textfelder

Etwa die Hälfte der Zeit tippt der Monkey einen gültigen Wert: Testdaten, deren Schlüssel im Namen oder Platzhalter
des Felds vorkommt (`email` passt zu „E-Mail address“), sonst einen schlichten Wert wie `Monkey`. In der anderen
Hälfte tippt er etwas Gemeines: leer, Leerraum, 10 000 Zeichen, Unicode mit Emoji und Rechts-nach-links-Text,
Sonderzeichen, HTML und skriptartige Zeichenketten, SQL-artige Zeichenketten, Zahlen außerhalb des Bereichs, ein
unmögliches Datum.

## Ausführen und Abwarten

Jede Aktion läuft mit `monkey.actionTimeoutMs` (Standard 5 s). Element-Aktionen lösen zuerst die Ref auf und
scheitern sofort, wenn sie veraltet ist. Hat sich das Hauptdokument geändert, wartet die Ausführung vor dem nächsten
Snapshot auf dessen `load`-Event.

**Eine fehlgeschlagene Aktion ist kein Befund:** Ein Element, das verschwunden ist, verdeckt ist oder nicht reagiert,
wird mit dem Fehler protokolliert, und der Lauf geht weiter. Probleme der Seite sind Sache der [Orakel](orakel.md);
ein Timeout beim Warten auf eine Navigation oder das Laden einer Seite ist die Ausnahme, es ist ein `hang`.

## Seiten, die etwas wissen wollen

Jede Seite des Kontexts der Rolle, Popups eingeschlossen, wird beobachtet (`src/monkey/events.ts`):

- **Native Dialoge** (`alert`, `confirm`, `prompt`, `beforeunload`) werden zufällig und sofort angenommen oder
  abgelehnt; ein Prompt bekommt einen schlichten oder gemeinen Wert. Ein offener Dialog würde die Seite blockieren,
  deshalb bleibt nie einer offen, nicht einmal einer, den eine Seite beim Laden zeigt.
- **Dateiauswahlen**, geöffnet durch einen Klick auf ein Dateifeld oder einen Button, der eine öffnet, bekommen eine
  erzeugte Datei: eine kleine Textdatei, ein PNG, eine leere Datei, 1 MiB, eine falsche Endung (`invoice.pdf.exe`),
  Text unter einem Namen auf `.png` und einen Unicode-Dateinamen; manchmal zwei, wenn das Feld mehrere annimmt.
  Keine Datei kommt von der Festplatte.
- **Downloads** werden unter `<report.dir>/<role>/downloads/` gespeichert, gemessen und am Ende der Rolle gelöscht,
  außer `report.keepDownloads` ist an. Ein fehlgeschlagener Download ist ein `download`-[Befund](orakel.md).

Jeder Schritt wartet bis zu `monkey.actionTimeoutMs`, bis diese abgeschlossen sind, und protokolliert sie mit dem
Schritt (`events` im [Aktionsprotokoll](../reference/aktionsprotokoll.md)); Replay gibt dieselben Antworten noch
einmal.

## Tabs und Popups

Öffnet eine Aktion ein Popup oder einen neuen Tab, macht der Monkey dort weiter, wie es ein Benutzer täte;
`switchTab` geht zurück. Die Orakel beobachten jeden Tab. Mit `stayOnDomain` wird ein Popup zu einer anderen Seite
blockiert und geschlossen, und der Monkey macht im ersten Tab weiter. Mehr als `monkey.maxTabs` offene Tabs
(Standard 5) werden nicht behalten: Die ältesten, die der Monkey zurückgelassen hat, werden geschlossen, nie der
erste Tab oder der aktuelle.

## Frames

[Same-Origin-Iframes](snapshot.md) gehören zum Snapshot, der Monkey handelt in ihnen also wie überall sonst, und die
Orakel sehen ihre Fehler. Cross-Origin-Iframes werden gezählt, nicht betreten: Playwright könnte in ihnen handeln,
aber ihr Inhalt gehört zu einer anderen Seite.

## Limits

Die Schleife hält bei `limits.maxSteps`, bei `limits.maxMinutes` (vor jedem Schritt geprüft) oder bei einer
Unterbrechung (Strg+C beendet den aktuellen Schritt und schreibt dann den Trace). Mit `stayOnDomain` wird eine Seite,
die auf einem anderen Origin oder als leere Seite endet, zurück zu `baseUrl` geschickt. Eine abgestürzte Seite wird
geschlossen, und der Lauf geht in einem anderen Tab oder einer frischen Seite weiter; das Orakel `crash` meldet es.

## Abdeckung auf der Fixture-Seite

Mit den Seeds 1, 2 und 3 erreicht der Monkey jede Seite der Fixture und löst alle fünf eingebauten Fehler aus
(JS-Fehler, Konsolenfehler, defekter Link, HTTP 500, Overflow), deutlich innerhalb der standardmäßigen 500 Schritte,
typischerweise in 100 bis 150. Der Test `test/monkey.test.ts` prüft das für diese drei Seeds.
