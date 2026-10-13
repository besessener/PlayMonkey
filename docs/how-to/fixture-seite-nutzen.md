# Die Fixture-Seite nutzen

Die Fixture-Seite in `fixtures/site/` ist eine kleine lokale Seite mit absichtlich eingebauten Fehlern. Ihre Seiten
und die Befunde, die sie erzeugen müssen, stehen in [fixtures/README.md](../../fixtures/README.md).

## Von Hand starten

```sh
npm run fixture             # free port; prints the URL, login and env vars
PORT=8080 npm run fixture   # fixed port
```

Richte eine Konfiguration mit `fixtures/configs/fixture.json` darauf aus; sie liest `FIXTURE_URL`, `FIXTURE_USER` und
`FIXTURE_PASS`.

## Aus einem Test starten

```ts
import { startFixture } from "../fixtures/site/server.ts";

const site = await startFixture(); // free port on 127.0.0.1, own sessions
try {
  // ... site.url ...
} finally {
  await site.close();
}
```

## Eine Seite hinzufügen

1. Füg in `fixtures/site/pages.ts` eine Route zu `createRoutes` hinzu; setz `link`, damit sie auf der Startseite
   erscheint.
2. Escape jede Eingabe, die die Seite wieder ausgibt, mit `escapeHtml`, damit Eingaben des Monkeys keine Fehler
   erzeugen, die nicht absichtlich eingebaut sind.
3. Trag die Seite und jeden eingebauten Fehler mit seinem Klickpfad und dem erwarteten Befund in `fixtures/README.md`
   ein.
4. Erweitere `test/fixture-site.test.ts` um den Klickpfad.
