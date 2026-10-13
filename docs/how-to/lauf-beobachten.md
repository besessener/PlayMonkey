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
