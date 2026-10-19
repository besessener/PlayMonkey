# Fixture-Seite

Eine kleine lokale Seite mit absichtlich eingebauten Fehlern, die die End-to-End-Tests nutzen. Sie ist die
**Ground Truth** für die Orakel: Ein Lauf gegen sie muss jeden Fehler unten melden und sonst nichts.

```sh
npm run fixture             # prints the URL, the login and the env vars for configs/fixture.json
PORT=8080 npm run fixture   # fixed port
```

In Tests:

```ts
import { startFixture } from "../fixtures/site/server.ts";

const site = await startFixture(); // free port on 127.0.0.1
// ... site.url ...
await site.close();
```

Test-Anmeldung: `monkey` / `banana-split` (`FIXTURE_CREDENTIALS`). `configs/fixture.json` liest URL und Zugangsdaten
aus `FIXTURE_URL`, `FIXTURE_USER` und `FIXTURE_PASS`.

## Seiten

| Pfad             | Inhalt                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `/`              | Links zu jeder Seite, dazu der kaputte Link.                                            |
| `/login`         | Formular mit Benutzername und Passwort. Eine richtige Anmeldung setzt ein Sitzungs-Cookie und leitet nach `/account` weiter. Eine falsche Anmeldung zeigt das Formular erneut mit einer Meldung an (Status 200). |
| `/account`       | Braucht eine Sitzung (sonst 303 nach `/login`). Hat einen Button „Log out“.             |
| `/form`          | Kontaktformular: Text, E-Mail, Auswahlliste, Checkbox, Textbereich. `novalidate`, damit der Browser das Absenden nie blockiert. Eine ungültige E-Mail-Adresse zeigt das Formular erneut mit einer Meldung an (Status 200). |
| `/js-error`      | Button, der beim Klick eine Exception wirft.                                            |
| `/console-error` | Schreibt beim Laden `console.error`.                                                    |
| `/overflow`      | 1600px breites Banner.                                                                  |
| `/clean`         | Kontrollseite mit einem Suchfeld und einem Umschalt-Button. Darf keine Befunde erzeugen. |

Jede Seite verlinkt zurück auf `/`. Zurückgegebene Eingaben sind HTML-escaped, damit skriptartige Eingaben des
Monkeys keine nicht eingebauten Fehler erzeugen können. Ein `data:`-Favicon verhindert die automatische Anfrage des
Browsers nach `/favicon.ico` (die ein 404 wäre).

## Eingebaute Fehler (erwartete Befunde)

Jeder Fehler muss **genau einmal** gemeldet werden (dedupliziert), mit diesen Orakeln:

| # | Fehler                | Klickpfad                                          | Orakel      | Schweregrad | Dedup-Schlüssel                 |
| - | --------------------- | -------------------------------------------------- | ----------- | ----------- | ------------------------------- |
| 1 | Kaputter interner Link | Startseite → „Broken link“                        | `http4xx`   | medium   | `GET /missing-page 404`         |
| 2 | Nicht abgefangene JS-Exception | Startseite → „JS error“ → „Do not press“  | `pageerror` | high     | `Seeded bug: click handler crashed` + erster Stack-Frame |
| 3 | HTTP 500 beim Absenden | Startseite → „Contact form“ → „Send“ mit leerem Namen oder einem Feld, das länger als 1000 Zeichen ist | `http5xx` | high | `POST /form 500` |
| 4 | Konsolenfehler        | Startseite → „Console error“                       | `console`   | medium   | `Seeded bug: console error on load` |
| 5 | Horizontaler Überlauf | Startseite → „Overflow“ (jeder Viewport schmaler als ~1650px) | `overflow` | low  | `/overflow` + verursachendes `div` |

Die 404- und die 500-Seite werden nicht zusätzlich als `errorPage` gemeldet (die HTTP-Orakel decken ihren Status
schon ab), und Chromiums Konsolenecho davon („Failed to load resource …“) ist kein `console`-Befund; siehe
[Orakel und Befunde](../docs/explanation/orakel.md). Der Dedup-Schlüssel des Überlaufs ist das verursachende
Element, nicht der Viewport, damit eine Größenänderung ihn nicht in mehrere Befunde aufteilt.

`/clean`, `/login`, `/account` und ein gültiges Absenden von `/form` sind Kontrollen und dürfen **keine** Befunde
erzeugen. `test/fixture-site.test.ts` geht jeden Klickpfad oben in einem echten Browser ab und prüft, dass die
Kontrollseiten still bleiben; `test/replay.test.ts` führt `configs/fixture.json` von Anfang bis Ende aus und
erwartet genau diese fünf Befunde.

## Das Labor

`/lab` enthält Seiten für die schwierigen Teile echter Websites. Die Startseite verlinkt **nicht** dorthin, ein Lauf
ab `/` erreicht es also nie, und die fünf Fehler oben bleiben genau fünf; starte einen Lauf bei `/lab`, um es
einzubeziehen (`/lab` verlinkt auf `/`).

| Pfad | Inhalt |
| --- | --- |
| `/lab` | Links zu jeder Laborseite und zurück zur Hauptseite. |
| `/lab/consent` | Ein bildschirmfüllendes Cookie-Banner (`role="dialog"`, „Accept all“, „Reject all“) über der Seite, bis es beantwortet ist; die Antwort wird in einem Cookie gespeichert. |
| `/lab/dialogs` | Buttons, die `alert`, `confirm` und `prompt` öffnen; eine Checkbox, die eine `beforeunload`-Warnung hinzufügt. |
| `/lab/alert-on-load` | Ein `alert` während des Ladens der Seite: Es blockiert das Load-Event, bis es beantwortet ist. |
| `/lab/frames` | Ein Iframe vom selben Origin, ein `srcdoc`-Iframe und ein Iframe von einem anderen Origin (`localhost` statt `127.0.0.1`). |
| `/lab/popups` | Ein Link mit `target="_blank"`, `window.open`, ein Popup, das sich selbst schließt, und ein Link mit `target="_blank"` zu einer externen Seite. |
| `/lab/upload` | Ein Dateifeld, eines für mehrere Dateien und ein Button, der ein verstecktes Dateifeld öffnet; listet die gewählten Dateien auf. |
| `/lab/download` | Ein funktionierender Download (`report.csv`, 29 Bytes) und ein kaputter. |
| `/lab/widgets` | Ein Hover-Menü, Doppelklick zum Bearbeiten, ein Kontextmenü, Drag-and-drop, langes Drücken. |
| `/lab/news` | Ein Button „Load news“, der per `fetch` `/lab/news.json` lädt und die Schlagzeile anzeigt. |
| `/lab/gallery` | Zwei Bilder, eines davon ohne Alternativtext, und ein Link „Next page“ auf dieselbe Seite mit Query. |

Eingebaute Fehler im Labor:

| # | Fehler | Klickpfad | Orakel | Schweregrad | Dedup-Schlüssel |
| - | --- | --- | --- | --- | --- |
| L1 | Nicht abgefangene Exception in einem Iframe | Labor → „Frames“ → „Crash in frame“ (im inneren Frame) | `pageerror` | high | `Seeded bug: frame handler crashed` + erster Stack-Frame |
| L2 | Nicht abgefangene Exception beim Laden eines Popups | Labor → „Popups“ → „Details in a new tab“ oder „Open a window“ | `pageerror` | high | `Seeded bug: popup failed to initialise` + erster Stack-Frame |
| L3 | Download bricht mitten in der Datei ab | Labor → „Download“ → „Download the export“ | `download` | medium | `/lab/files/export.zip` |
| L4 | Fehlgeschlagene Anfrage wird nicht abgefangen | Labor → „News“ → Aktion `offline` → „Load news“ | `pageerror` | high | `TypeError: Failed to fetch` + erster Stack-Frame |
| L5 | Bild ohne Alternativtext | Labor → „Gallery“ | `accessibility` | medium | `image-alt` + `/lab/gallery` |

L4 tritt nur ohne Netz auf, also nur mit der Aktion `offline`, die standardmäßig aus ist; online ist „Load news“ eine
Kontrolle. `test/network.test.ts` prüft beides. L5 meldet nur das Orakel `accessibility`, das standardmäßig aus ist;
`test/accessibility.test.ts` prüft, dass es genau einmal kommt, auch über „Next page“ und einen zweiten Besuch hinweg.
Alle anderen Seiten der Fixture-Seite bestehen die Prüfung ohne Verstoß.

`test/lab.test.ts` geht jede Laborseite mit vorgegebenen Aktionen durch die echte Laufschleife ab;
`test/chaos.test.ts` lässt 20 Seeds auf das Labor und die Hauptseite los und prüft, dass kein Lauf abstürzt, hängt
oder sein Zeitlimit überschreitet.

## Störungen

`/lab/faults` enthält Seiten, auf denen eine Seite oder eine Verbindung stehen bleibt. Weder die Startseite noch das
Labor verlinken dorthin, andere Läufe erreichen sie also nie; `test/faults.test.ts` startet dort oder geht direkt hin.

| Pfad | Inhalt |
| --- | --- |
| `/lab/faults` | Links zu jeder Seite unten. |
| `/lab/faults/soft-404` | „Not found“ mit Status 200. |
| `/lab/faults/slow` | Ein Link „Open the report“ auf `/lab/faults/never`, das nie antwortet. |
| `/lab/faults/reset` | Ein Link „Load the data“ auf `/lab/faults/crash`, wo der Server die Verbindung ohne Antwort abbricht. |
| `/lab/faults/busy` | Ein Button „Recalculate“, der die Seite einfriert (Endlosschleife), ebenso jeder Tastendruck. |
| `/lab/faults/guard` | Eine Checkbox „I changed something“, danach fragt die Seite per `beforeunload` vor dem Verlassen. |
| `/lab/faults/bad-link` | Ein Link mit der ungültigen Adresse `http://` und ein gültiger. |
| `/lab/faults/login` | Ein Anmeldeformular (`username`, `password`, „Log in“), das an `/lab/faults/session` geht. Falsche Zugangsdaten zeigen das Formular dort noch einmal, mit Status 200; richtige setzen dasselbe Sitzungscookie wie `/login` und leiten auf `/account` weiter. |

Eingebaute Fehler:

| # | Fehler | Klickpfad | Orakel | Schweregrad | Dedup-Schlüssel |
| - | --- | --- | --- | --- | --- |
| S1 | Weiche Fehlerseite | Störungen → „Old offer“ | `errorPage` | medium | `/lab/faults/soft-404` + Status `200` |
| S2 | Seite antwortet nie | Störungen → „Slow report“ → „Open the report“ | `hang` | high | `navigation` + `/lab/faults/never` |
| S3 | Server bricht die Verbindung ab | Störungen → „Unstable server“ → „Load the data“ | `errorPage` | high | `/lab/faults/crash` + Fehlercode (`net::ERR_EMPTY_RESPONSE`) |
| S4 | Seite friert ein | Störungen → „Busy page“ → „Recalculate“ oder eine Taste | `hang` | high | `unresponsive` + `/lab/faults/busy` |

Jeder kommt genau einmal, auch wenn der Monkey die Seite mehrmals besucht oder von einer anderen Seite her kommt. Die
Warnung von `/lab/faults/guard` ist kein Fehler: Ein `back`, bei dem der Monkey sie ablehnt, ist kein `hang`. Der
ungültige Link von `/lab/faults/bad-link` ist ein Fehler der Seite, den kein Orakel meldet, der aber den Lauf nicht
beenden darf. Eine eingefrorene Seite wird geschlossen und ersetzt, und der Lauf geht weiter. Die Anmeldung unter
`/lab/faults/login` ist kein Fehler der Seite, sondern prüft PlayMonkey: `test/session.test.ts` erwartet, dass
falsche Zugangsdaten dort scheitern, obwohl die URL danach eine andere ist.

## Visuelle Fehler

`/lab/visual` enthält einen Fehler, der nur auf dem Bild zu sehen ist; das DOM ist in Ordnung, und kein Orakel außer
`visual` meldet etwas. Weder die Startseite noch das Labor verlinken dorthin; `test/visual.test.ts` startet dort.

| Pfad | Inhalt |
| --- | --- |
| `/lab/visual` | Kasse mit dem Button „Pay now“ und einem Badge „Free shipping over 50 euros“, dazu ein Link auf die korrigierte Fassung. |
| `/lab/visual/clean` | Dieselbe Kasse, das Badge steht neben dem Button. Kontrolle: Darf keinen Befund erzeugen. |

| # | Fehler | Klickpfad | Orakel | Schweregrad | Dedup-Schlüssel |
| --- | --- | --- | --- | --- | --- |
| V1 | Das Badge liegt über dem Button und verdeckt seine Beschriftung | `/lab/visual` | `visual` | medium | `/lab/visual` + `overlap` |

Ob ein echtes Modell V1 sieht, hängt vom Modell ab; `test/visual.test.ts` prüft mit einem geskripteten Anbieter, dass
der Befund genau einmal kommt, jede Seite nur einmal geprüft wird und das Badge den Button wirklich überdeckt.

## Der Demo-Shop

`/demo` ist „Monkey Market“, ein gestalteter kleiner Obstladen für Vorführungen: Anmeldung, Produktkatalog,
Warenkorb und Kasse. Wie das Labor ist er von der Startseite aus **nicht** verlinkt, und er verlinkt auch nicht zurück:
Ein Lauf ab `/demo` bleibt im Shop und findet nur dessen Fehler, die fünf Fehler oben bleiben genau fünf. Er nutzt
dieselben Zugangsdaten wie `/login`, aber ein eigenes Sitzungs-Cookie (`shop_sid`). Sein Code liegt mit Konfiguration und
Startskript im Ordner [`demo/`](../demo/); die Fixture-Seite bindet nur seine Routen ein.

| Pfad | Inhalt |
| --- | --- |
| `/demo` | Startseite mit „Start shopping“. |
| `/demo/login` | Anmeldung. Eine falsche Anmeldung zeigt das Formular erneut mit einer Meldung an (Status 200); angemeldet leitet sie nach `/demo/shop` weiter. |
| `/demo/shop` | Sechs Produkte mit Mengenfeld (1 bis 9) und „Add … to cart“. Braucht eine Sitzung (sonst 303 nach `/demo/login`), wie alle Seiten unten. |
| `/demo/cart` | Warenkorb mit „Remove …“ und dem Kassenformular: Name, E-Mail, Gutscheincode, „Place order“. `novalidate`. Ein unbekannter Gutschein zeigt eine Meldung an (Status 200); `MONKEY10` gibt zehn Prozent Rabatt. |
| `/demo/account` | Der Benutzername oben rechts führt hierher; hat den Button „Sign out“. |

Ein `GET` auf die Formularziele `/demo/checkout`, `/demo/cart/remove` und `/demo/logout` leitet nach `/demo/cart`
weiter, damit ein Neuladen nicht auf der 404-Seite der Hauptseite landet.

Eingebaute Fehler im Demo-Shop:

| # | Fehler | Klickpfad | Orakel | Schweregrad | Dedup-Schlüssel |
| - | --- | --- | --- | --- | --- |
| D1 | HTTP 500 beim Bestellen | Shop → „Add … to cart“ → „Place order“ mit leerer E-Mail-Adresse oder einer ohne Domain | `http5xx` | high | `POST /demo/checkout 500` |
| D2 | Der sichtbare Text „Add to cart“ ist nicht Teil des zugänglichen Namens „Add Bananas to cart“ | Shop | `accessibility` | medium | `label-content-name-mismatch` + `/demo/shop` |

`../demo/demo.json` lässt den Monkey als Rolle `shopper` mit LLM und eingeschaltetem Orakel `accessibility` los. Die
Zugangsdaten der Demo stehen direkt darin, sie sind nur ausgedacht und werden darum nicht als `***` maskiert; nötig
sind `FIXTURE_URL` und `MONKEY_LLM_URL`, `MONKEY_LLM_DEPLOYMENT` und `MONKEY_LLM_API_KEY`. `../demo/demo-openai.json`
ist dieselbe Demo für einen OpenAI-kompatiblen Endpunkt (`provider: "openai"`, Chat Completions). Mit Seed 11 findet er ohne
LLM D2 in Schritt 1 und D1 in Schritt 12. `test/shop.test.ts` prüft die Seiten über HTTP, beide Fehler genau einmal,
einen Kontrolldurchlauf, der nur D2 meldet, und einen Lauf mit dieser Konfiguration ohne LLM, der genau diese zwei
Befunde liefert.

## Eine Seite hinzufügen

Füge in `site/pages.ts` eine Route zu `createRoutes` hinzu (setze `link`, damit sie auf der Startseite erscheint),
trage ihren eingebauten Fehler in die Tabelle oben ein und erweitere `test/fixture-site.test.ts` um ihren Klickpfad.
