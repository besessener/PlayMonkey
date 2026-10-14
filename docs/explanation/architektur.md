# Architektur

```text
config  ->  auth/session  ->  loop { snapshot -> choose action (monkey | LLM) -> execute -> oracles }  ->  action log + report
                                                   ^
                                     provider interface: anthropic-foundry | openai
```

Ein Lauf lädt die Konfiguration, öffnet einen Browser und einen Kontext pro Rolle und wiederholt dann: einen Snapshot
der Seite aufnehmen, die nächste Aktion wählen (der Zufalls-Monkey mit Seed oder das LLM, wenn der Monkey feststeckt),
sie ausführen und die Orakel prüfen lassen, was passiert ist. Jede Aktion landet in einem Aktionsprotokoll, jedes
Problem in einem deduplizierten Befund, und am Ende des Laufs steht ein Bericht.

## Module

| Pfad | Zuständigkeit | Stand |
| --- | --- | --- |
| `src/cli/` | Argumente parsen (`node:util` `parseArgs`), Unterbefehle, Exit-Codes | umgesetzt |
| `src/config/` | JSON Schema, Auflösung von `${VAR}`, Validierung, Standardwerte, Maskierung von Secrets | umgesetzt |
| `src/auth/` | Browserstart, ein Kontext pro Rolle, Anmeldung, `stayOnDomain` und `scope`, Trace und Video | umgesetzt |
| `src/snapshot/` | Seiten-Snapshot mit Element-Refs, Snapshot-Hash, Serialisierer für das LLM | umgesetzt |
| `src/monkey/` | Zufallsgenerator für Aktionen mit Seed, Ausführung und Schleife des Laufs | umgesetzt |
| `src/run.ts` | Plant die Läufe (Rollen × Seeds) und führt jeweils `parallel` davon gleichzeitig aus: Sitzung, Monkey oder Replay, Orakel, Aktionsprotokoll, Artefakte | umgesetzt |
| `src/oracles/` | Befunde erkennen und deduplizieren, Screenshots | umgesetzt |
| `src/replay/` | Schreiben und Lesen des Aktionsprotokolls, Parser für dauerhafte Locators, `monkey replay` | umgesetzt |
| `src/report/` | `report.json` und der in sich geschlossene `report.html` | umgesetzt |
| `src/llm/` | Anbieter-Schnittstelle, Backends `anthropic-foundry` und `openai`, Prompt, Vorabprüfung, Erkennung des Feststeckens, Übergabe, Verbrauch | umgesetzt |
| `fixtures/site/` | Lokale Seite mit eingebauten Fehlern, die Grundwahrheit für End-to-End-Tests | umgesetzt |

## Entwurfsentscheidungen

- **Die Bibliotheks-API von Playwright, nicht der MCP-Server:** Das Werkzeug braucht die Kontrolle über die Wahl der
  Aktionen, den Seed und die Orakel.
- **Das LLM ist optional und kommt nur gelegentlich zum Zug.** Standard ist der Zufalls-Monkey; das LLM springt nur
  ein, wenn er feststeckt. So bleiben Läufe günstig, und ein Ausfall des LLM hält nie einen Lauf an.
- **Befunde müssen reproduzierbar sein.** LLM-Entscheidungen sind nicht deterministisch, deshalb wird jede Aktion
  mit einem dauerhaften Locator protokolliert, und `monkey replay` führt das Protokoll ohne LLM erneut aus.
- **Ein Kontext pro Lauf:** Cookies und Speicher gehen nie zwischen Rollen oder Seeds über, deshalb können Läufe
  parallel in einem Browser laufen. LLM-Budget und Circuit Breaker teilen sich alle Läufe.
