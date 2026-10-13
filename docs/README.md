# PlayMonkey documentation

Organised by [Diátaxis](https://diataxis.fr/): by what you need right now.

|  | For learning | For working |
| --- | --- | --- |
| **Practice** | [Tutorials](#tutorials) – step by step to a first success | [How-to guides](#how-to-guides) – reach one concrete goal |
| **Knowledge** | [Explanation](#explanation) – understand why it is so | [Reference](#reference) – look up exactly how it is |

## Tutorials

- [Getting started](tutorials/erste-schritte.md) – install, start the fixture site, validate a config.
- [Development setup](tutorials/entwicklungsumgebung.md) – from clone to all checks green.

## How-to guides

**Using PlayMonkey**

- [Configure login](how-to/anmeldung-einrichten.md) – form login, saved sessions, several roles, secrets.
- [Configure the LLM](how-to/llm-einrichten.md) – Claude on Microsoft Foundry, preflight, budget, troubleshooting.
- [Run in parallel](how-to/parallel-ausfuehren.md) – several roles and seeds at the same time, one combined report.
- [Run in CI](how-to/in-ci-ausfuehren.md) – a GitHub Actions workflow with secrets, the report as artifact and exit codes.
- [Reproduce a finding](how-to/befund-reproduzieren.md) – steps in the report, trace viewer, replay, seed.
- [Watch a run](how-to/lauf-beobachten.md) – spectator mode for watching and demos: visible, slowed down, outlined.

**Developing PlayMonkey**

- [Contributing](../CONTRIBUTING.md) – set up, work, open a pull request, release.
- [Use the fixture site](how-to/fixture-seite-nutzen.md) – start it, point a config at it, add a page.
- [Maintain the website](how-to/webseite-pflegen.md) – `site/` and the Pages workflow.

## Reference

- [Configuration](reference/konfiguration.md) – every key with type, default and meaning.
- [Report](reference/bericht.md) – the report directory, `report.html`, `report.json`, what traces contain.
- [Action log](reference/aktionsprotokoll.md) – the `actions.json` format, placeholders for secrets.
- [Commands](reference/befehle.md) – the `monkey` CLI, exit codes, npm scripts and environment variables.
- [Quality gates](reference/qualitaetssicherung.md) – lint rules, import boundaries, coverage thresholds, hooks, CodeQL.
- [Fixture site](../fixtures/README.md) – pages, seeded bugs and the findings they must produce.

## Explanation

- [Architecture](explanation/architektur.md) – the run pipeline, modules and what exists today.
- [Ground rules](explanation/grundregeln.md) – test environments only, stop conditions, secrets, role isolation.
- [Sessions and login](explanation/sitzungen.md) – contexts, the login heuristic, stayOnDomain, trace and video.
- [Page snapshots](explanation/snapshot.md) – elements and refs, frames, the snapshot hash, the LLM serializer.
- [The random monkey](explanation/monkey.md) – seeding, how actions and values are chosen, limits.
- [Oracles and findings](explanation/orakel.md) – what counts as a bug, the finding model, deduplication, ignore rules, adding an oracle.
- [The LLM](explanation/llm.md) – when the monkey hands over, fallback and circuit breaker, secrets, adding a backend.
- [Replay](explanation/replay.md) – how a run is repeated without randomness or LLM, drift, the result.
- [Tooling choices](explanation/werkzeuge.md) – why `node:test`, Biome, Knip, these TypeScript settings and so few dependencies.

Related projects with the same idea and the same documentation layout:
[flakipype](https://github.com/besessener/flakipype/blob/main/docs/README.md) and
[Archivist](https://github.com/besessener/Archivist/blob/main/docs/README.md) (in German).
