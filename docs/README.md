# PlayMonkey-Dokumentation

Die Dokumentation folgt [Diátaxis](https://diataxis.fr/): Sie ist nach dem geordnet, was du gerade brauchst.

|  | Zum Lernen | Für die Arbeit |
| --- | --- | --- |
| **Praxis** | [Tutorials](#tutorials) – Schritt für Schritt zum ersten Erfolg | [Anleitungen](#anleitungen) – ein konkretes Ziel erreichen |
| **Wissen** | [Hintergrund](#hintergrund) – verstehen, warum es so ist | [Referenz](#referenz) – nachschlagen, wie es genau ist |

## Tutorials

- [Erste Schritte](tutorials/erste-schritte.md) – installieren, die Fixture-Seite starten, eine Konfiguration prüfen.
- [Entwicklungsumgebung aufsetzen](tutorials/entwicklungsumgebung.md) – vom Klonen bis zu allen Prüfungen grün.

## Anleitungen

**PlayMonkey benutzen**

- [Anmeldung einrichten](how-to/anmeldung-einrichten.md) – Formular-Login, gespeicherte Sitzungen, mehrere Rollen, Secrets.
- [LLM einrichten](how-to/llm-einrichten.md) – Claude auf Microsoft Foundry, Preflight, Budget, Fehlerbehebung.
- [Parallel ausführen](how-to/parallel-ausfuehren.md) – mehrere Rollen und Seeds gleichzeitig, ein gemeinsamer Bericht.
- [In CI ausführen](how-to/in-ci-ausfuehren.md) – ein GitHub-Actions-Workflow mit Secrets, dem Bericht als Artefakt und Exit-Codes.
- [Einen Befund reproduzieren](how-to/befund-reproduzieren.md) – Schritte im Bericht, Trace-Viewer, Replay, Seed.
- [Einen Lauf beobachten](how-to/lauf-beobachten.md) – Zuschauermodus zum Zusehen und für Demos: sichtbar, verlangsamt, umrandet.

**PlayMonkey entwickeln**

- [Mitmachen](../CONTRIBUTING.md) – einrichten, arbeiten, Pull Request öffnen, veröffentlichen.
- [Die Fixture-Seite nutzen](how-to/fixture-seite-nutzen.md) – starten, eine Konfiguration darauf richten, eine Seite hinzufügen.
- [Webseite pflegen](how-to/webseite-pflegen.md) – `site/` und der Pages-Workflow.

## Referenz

- [Konfiguration](reference/konfiguration.md) – jeder Schlüssel mit Typ, Standardwert und Bedeutung.
- [Bericht](reference/bericht.md) – das Berichtsverzeichnis, `report.html`, `report.json`, was Traces enthalten.
- [Aktionsprotokoll](reference/aktionsprotokoll.md) – das Format von `actions.json`, Platzhalter für Secrets.
- [Befehle](reference/befehle.md) – die `monkey`-CLI, Exit-Codes, npm-Skripte und Umgebungsvariablen.
- [Qualitätsprüfungen](reference/qualitaetssicherung.md) – Lint-Regeln, Importgrenzen, Abdeckungsschwellen, Hooks, CodeQL.
- [Fixture-Seite](../fixtures/README.md) – Seiten, eingebaute Fehler und die Befunde, die sie erzeugen müssen.

## Hintergrund

- [Architektur](explanation/architektur.md) – die Lauf-Pipeline, die Module und was es heute gibt.
- [Grundregeln](explanation/grundregeln.md) – nur Testumgebungen, Abbruchbedingungen, Secrets, Trennung der Rollen.
- [Sitzungen und Anmeldung](explanation/sitzungen.md) – Kontexte, die Login-Heuristik, stayOnDomain, Trace und Video.
- [Seiten-Snapshots](explanation/snapshot.md) – Elemente und Refs, Frames, der Snapshot-Hash, der LLM-Serialisierer.
- [Der Zufalls-Monkey](explanation/monkey.md) – Seeding, wie Aktionen und Werte gewählt werden, Limits.
- [Orakel und Befunde](explanation/orakel.md) – was als Fehler zählt, das Befundmodell, Deduplizierung, Ignorierregeln, ein Orakel hinzufügen.
- [Das LLM](explanation/llm.md) – wann der Monkey übergibt, Fallback und Circuit Breaker, Secrets, ein Backend hinzufügen.
- [Replay](explanation/replay.md) – wie ein Lauf ohne Zufall und ohne LLM wiederholt wird, Abweichungen, das Ergebnis.
- [Werkzeugwahl](explanation/werkzeuge.md) – warum `node:test`, Biome, Knip, diese TypeScript-Einstellungen und so wenige Abhängigkeiten.

Verwandte Projekte mit derselben Idee und demselben Aufbau der Dokumentation:
[flakipype](https://github.com/besessener/flakipype/blob/main/docs/README.md) und
[Archivist](https://github.com/besessener/Archivist/blob/main/docs/README.md).
