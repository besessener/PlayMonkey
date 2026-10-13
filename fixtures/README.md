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
Kontrollseiten still bleiben; `test/oracles.test.ts` führt `configs/fixture.json` von Anfang bis Ende aus und
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

Eingebaute Fehler im Labor:

| # | Fehler | Klickpfad | Orakel | Schweregrad | Dedup-Schlüssel |
| - | --- | --- | --- | --- | --- |
| L1 | Nicht abgefangene Exception in einem Iframe | Labor → „Frames“ → „Crash in frame“ (im inneren Frame) | `pageerror` | high | `Seeded bug: frame handler crashed` + erster Stack-Frame |
| L2 | Nicht abgefangene Exception beim Laden eines Popups | Labor → „Popups“ → „Details in a new tab“ oder „Open a window“ | `pageerror` | high | `Seeded bug: popup failed to initialise` + erster Stack-Frame |
| L3 | Download bricht mitten in der Datei ab | Labor → „Download“ → „Download the export“ | `download` | medium | `/lab/files/export.zip` |

`test/lab.test.ts` geht jede Laborseite mit vorgegebenen Aktionen durch die echte Laufschleife ab;
`test/chaos.test.ts` lässt 20 Seeds auf das Labor und die Hauptseite los und prüft, dass kein Lauf abstürzt, hängt
oder sein Zeitlimit überschreitet.

## Eine Seite hinzufügen

Füge in `site/pages.ts` eine Route zu `createRoutes` hinzu (setze `link`, damit sie auf der Startseite erscheint),
trage ihren eingebauten Fehler in die Tabelle oben ein und erweitere `test/fixture-site.test.ts` um ihren Klickpfad.
