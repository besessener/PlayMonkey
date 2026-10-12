# PlayMonkey documentation

Organised by [Diátaxis](https://diataxis.fr/).

## Tutorials

- [Getting started](tutorials/getting-started.md) – install, start the fixture site, validate a config.
- [Development setup](tutorials/development-setup.md) – from clone to all checks green.

## How-to guides

- [Configure login](how-to/configure-login.md) – form login, saved sessions, several roles, secrets.
- [Configure the LLM](how-to/configure-llm.md) – Claude on Microsoft Foundry, preflight, budget, troubleshooting.
- [Watch a run](how-to/watch-a-run.md) – spectator mode for watching and demos: visible, slowed down, outlined.
- [Use the fixture site](how-to/use-the-fixture-site.md) – start it, point a config at it, add a page.
- [Maintain the website](how-to/maintain-the-website.md) – `site/` and the Pages workflow.

## Reference

- [Configuration](reference/configuration.md) – every key with type, default and meaning.
- [Report](reference/report.md) – the report directory, `report.html`, `report.json`, what traces contain.
- [Action log](reference/action-log.md) – the `actions.json` format, placeholders for secrets.
- [Commands](reference/commands.md) – the `monkey` CLI, exit codes, npm scripts and environment variables.
- [Fixture site](../fixtures/README.md) – pages, seeded bugs and the findings they must produce.

## Explanation

- [Architecture](explanation/architecture.md) – the run pipeline, modules and what exists today.
- [Ground rules](explanation/ground-rules.md) – test environments only, stop conditions, secrets, role isolation.
- [Sessions and login](explanation/sessions.md) – contexts, the login heuristic, stayOnDomain, trace and video.
- [Page snapshots](explanation/snapshot.md) – elements and refs, frames, the snapshot hash, the LLM serializer.
- [The random monkey](explanation/monkey.md) – seeding, how actions and values are chosen, limits.
- [Oracles and findings](explanation/oracles.md) – what counts as a bug, the finding model, deduplication, ignore rules.
- [The LLM](explanation/llm.md) – when the monkey hands over, fallback and circuit breaker, secrets, adding a backend.
- [Replay](explanation/replay.md) – how a run is repeated without randomness or LLM, drift, the result.
- [Tooling choices](explanation/tooling.md) – why `node:test`, Biome, these TypeScript settings and so few dependencies.
- [Roadmap](explanation/roadmap.md) – milestones and status.
