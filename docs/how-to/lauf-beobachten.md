# Einen Lauf beobachten (Zuschauermodus)

Um zu sehen, was der Monkey tut, sei es, um ein Auge darauf zu haben, oder für eine Demo, hängst du `--watch` (`-w`)
an:

```sh
monkey run config.json --watch
monkey replay monkey-report/user/actions.json --config config.json --watch
```

Der Zuschauermodus:

- öffnet einen **sichtbaren Browser**, egal, was in `browser.headless` steht;
- verlangsamt jede Browseroperation (`slowMo` von Playwright, Standard 250 ms);
- **umrandet jedes Element** kurz vor dem Klicken, Tippen oder Auswählen orange, beschriftet mit seinem Locator;
- gibt **eine Zeile pro Schritt** aus, mit dem, der ihn gewählt hat (`monkey` oder `llm`), und wie er ausging:

  ```text
  [user] step 12 monkey: click getByRole('link', { name: 'Contact form' })
  [user] step 13 llm: fill getByRole('textbox', { name: 'Email' }) "monkey@test.local"
  [user] step 14 monkey: press Enter -> failed: Timeout 5000ms exceeded.
  ```

Werte, die aus `${VAR}`-Secrets getippt werden, erscheinen als `***`. Der Zuschauermodus ändert nur das Timing:
Derselbe Seed führt zu denselben Aktionen wie ohne `--watch`, die Umrandung wird vor der Aktion und dem nächsten
Snapshot entfernt, und Befunde, Aktionsprotokoll, Trace und Bericht werden wie gewohnt geschrieben.

## Geschwindigkeit

`--slow-mo <ms>` setzt die Verzögerung pro Browseroperation und schließt `--watch` ein. Die Umrandung bleibt doppelt
so lange stehen, mindestens 300 ms.

| Zweck | Flags |
| --- | --- |
| Live-Demo, leicht zu verfolgen | `--slow-mo 600` |
| Standard | `--watch` (250 ms) |
| Einen langen Lauf im Auge behalten | `--slow-mo 0`: volle Geschwindigkeit, keine Umrandung, trotzdem sichtbar mit Schrittzeilen |

Senk `limits.maxSteps` für eine Demo: Bei der Standardgeschwindigkeit dauert ein Schritt etwa ein bis zwei Sekunden.
Strg+C hält nach dem aktuellen Schritt an und schreibt trotzdem den Bericht.

Eine fertige Demo, die ganz lokal läuft, ist der Demo-Shop der [Fixture-Seite](../../fixtures/README.md#der-demo-shop):
ein gestalteter Obstladen mit Anmeldung, Warenkorb und einem eingebauten Fehler an der Kasse. Shop, Konfiguration und
Startskript liegen zusammen im Ordner `demo/`. Starte die Fixture-Seite (`npm run fixture`), setz `FIXTURE_URL` auf die
ausgegebene Adresse und für das LLM `MONKEY_LLM_URL`, `MONKEY_LLM_DEPLOYMENT` und `MONKEY_LLM_API_KEY` (siehe
[LLM einrichten](llm-einrichten.md)), dann in einem zweiten Terminal:

```sh
npx monkey run demo/demo.json --slow-mo 600
```

Unter Windows erledigt `demo/demo.ps1` alles in einem Schritt. Es prüft zuerst, ob `MONKEY_LLM_URL`,
`MONKEY_LLM_API_KEY` und `MONKEY_LLM_DEPLOYMENT` gesetzt sind (in der Sitzung oder in deinem Benutzerprofil), und bricht
sonst mit einer Liste der fehlenden Variablen ab. Dann startet es die Fixture-Seite (falls auf dem Port noch keine
läuft), startet den Lauf mit `demo/demo.json` und beendet die Seite danach wieder:

```powershell
powershell -ExecutionPolicy Bypass -File demo/demo.ps1            # Port 8080, --slow-mo 600
powershell -ExecutionPolicy Bypass -File demo/demo.ps1 -SlowMo 0  # volle Geschwindigkeit
```

Eine gute Demo ist ein [Replay](../explanation/replay.md) eines Laufs, der etwas gefunden hat: Es zeigt genau die
Schritte bis zum Fehler und endet dort, ohne Zufall und ohne LLM.

## Ohne Bildschirm

Ein sichtbarer Browser braucht einen Bildschirm. Auf einem Linux-Rechner oder in einem Container ohne Bildschirm
lässt du ihn unter einem virtuellen Bildschirm laufen:

```sh
xvfb-run -a monkey run config.json --watch
```

Ohne Bildschirm endet `monkey run --watch` mit Exit-Code `2` und sagt das. Um einen headless Lauf hinterher
anzusehen, nimm den Trace (`npx playwright show-trace <role>/trace.zip`) und das Video im Berichtsverzeichnis.
