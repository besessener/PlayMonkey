# In der CI ausführen

Lass den Monkey bei jedem Pull Request, nachts oder von Hand laufen, bewahr den Bericht als Build-Artefakt auf und lass
den [Exit-Code](../reference/befehle.md#exit-codes) entscheiden, ob der Job fehlschlägt.

## PlayMonkey in deinem Projekt installieren

PlayMonkey wird aus git als Dev-Dependency installiert; npm baut es bei der Installation (über sein Skript `prepare`):

```sh
npm install --save-dev github:besessener/PlayMonkey
npx monkey --help
```

Leg dich für reproduzierbare Builds auf ein Release-Tag (`github:besessener/PlayMonkey#v0.7.0`, siehe die
[Releases](https://github.com/besessener/PlayMonkey/releases)) oder einen Commit fest. Check deine Konfiguration
daneben ein, z. B. `monkey.json`, mit jedem Secret als Platzhalter `${VAR}` (siehe
[Anmeldung einrichten](anmeldung-einrichten.md#secrets-aus-der-datei-heraushalten)).

## Der Workflow

Das ist `.github/workflows/monkey.yml` aus dem PlayMonkey-Repository. Er läuft dort bei jedem Pull Request gegen die
[Fixture-Seite](fixture-seite-nutzen.md), und `test/docs.test.ts` prüft, dass diese Seite ihn unverändert zeigt; so
kann das Beispiel nicht veralten. Kopier ihn in dein Repository und pass die mit `CHANGE` markierten Zeilen an:

```yaml
# Example: run PlayMonkey against a test environment in GitHub Actions.
# This copy runs in PlayMonkey's own CI against the fixture site, so the example cannot rot.
# docs/how-to/in-ci-ausfuehren.md explains it; the lines marked CHANGE are the ones to adapt for your project.
name: Monkey

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  monkey:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      MONKEY_CONFIG: fixtures/configs/fixture.json # CHANGE: your config file
      MONKEY_REPORT: fixtures/configs/monkey-report # CHANGE: its report.dir, relative to the repository
      # Findings (exit 1) only warn; "true" fails the job on them. Exit 2 always fails.
      FAIL_ON_FINDINGS: "false"
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 26
          cache: npm
      # Installs PlayMonkey with the other dependencies. In your project it is a devDependency:
      #   npm install --save-dev github:besessener/PlayMonkey
      # npm builds it on install.
      - name: Install dependencies
        run: npm ci
      - name: Install the browser
        run: npx playwright install --with-deps chromium
      # CHANGE: remove this step; your test environment is already running somewhere.
      - name: Start the fixture site
        run: |
          PORT=4173 npm run fixture > "$RUNNER_TEMP/fixture.log" 2>&1 &
          for _ in $(seq 30); do
            curl -sf http://127.0.0.1:4173/ > /dev/null && exit 0
            sleep 1
          done
          cat "$RUNNER_TEMP/fixture.log"
          exit 1
      - name: Run the monkey
        id: monkey
        env:
          # CHANGE: the variables your config's ${VAR} placeholders use, from the CI secret store.
          # The fixture's login is public, so it is the fallback when the secrets are not set (e.g. on forks).
          FIXTURE_URL: http://127.0.0.1:4173
          FIXTURE_USER: ${{ secrets.MONKEY_USER || 'monkey' }}
          FIXTURE_PASS: ${{ secrets.MONKEY_PASS || 'banana-split' }}
        run: |
          set +e
          npx monkey run "$MONKEY_CONFIG"
          echo "code=$?" >> "$GITHUB_OUTPUT"
      # Traces and videos hold the test environment's session cookies: keep the artifact private and short-lived.
      - name: Upload the report
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: monkey-report
          path: ${{ env.MONKEY_REPORT }}
          retention-days: 7
          if-no-files-found: ignore
      - name: Check the exit code
        env:
          CODE: ${{ steps.monkey.outputs.code }}
        run: |
          case "$CODE" in
            0) echo "No findings." ;;
            1)
              if [ "$FAIL_ON_FINDINGS" = "true" ]; then
                echo "::error::PlayMonkey found problems; see the monkey-report artifact."
                exit 1
              fi
              echo "::warning::PlayMonkey found problems; see the monkey-report artifact."
              ;;
            *)
              echo "::error::PlayMonkey did not complete (exit ${CODE:-none}); see the log above."
              exit 1
              ;;
          esac
```

Was er tut:

1. **Installiert** Node.js 26, die Abhängigkeiten des Projekts (darunter PlayMonkey) und Chromium mit seinen
   Systembibliotheken (`--with-deps`).
2. **Startet die Fixture-Seite.** Das braucht nur PlayMonkeys eigene Kopie; deine Testumgebung läuft schon, also
   lösch den Schritt.
3. **Führt den Monkey aus**, mit den Variablen für die Platzhalter `${VAR}` der Konfiguration aus dem Secret-Speicher
   der CI (*Settings → Secrets and variables → Actions*). Setz die Basis-URL genauso, wenn sie je Umgebung anders ist,
   z. B. `"baseUrl": "${TEST_URL}"` und `TEST_URL: ${{ vars.TEST_URL }}`. `set +e` hält den Schritt grün, damit der
   Bericht in jedem Fall hochgeladen wird; der Exit-Code geht in die Ausgabe des Schritts.
4. **Lädt das Berichtsverzeichnis** als Artefakt `monkey-report` hoch, auch wenn der Lauf fehlgeschlagen ist. Lad es
   von der Übersichtsseite des Laufs herunter und öffne `report.html`. Traces und Videos darin enthalten die
   Sitzungscookies der Testumgebung (siehe [Bericht: Secrets](../reference/bericht.md#secrets)), daher die kurze
   Aufbewahrung.
5. **Prüft den Exit-Code:** `0` besteht; `1` (Befunde) warnt oder schlägt mit `FAIL_ON_FINDINGS: "true"` fehl; `2`
   (Konfigurationsfehler, gescheiterte Anmeldung, gescheiterter [LLM-Preflight](llm-einrichten.md#fehlerbehebung),
   abgestürzter Lauf) schlägt immer fehl.

## Varianten

- **Nachts:** Füg `schedule: [{ cron: "17 3 * * *" }]` unter `on:` hinzu und lass länger laufen (`limits.maxSteps`,
  `limits.maxMinutes`) als bei Pull Requests.
- **Mehr Abdeckung in derselben Zeit:** mehrere Seeds und Rollen nebeneinander, siehe
  [Parallel ausführen](parallel-ausfuehren.md). Halte `limits.maxMinutes` × Anzahl der Läufe ÷ `parallel` unter dem
  `timeout-minutes` des Jobs.
- **Mit einem LLM:** Füg den Abschnitt `llm` und seinen Schlüssel hinzu
  (`FOUNDRY_API_KEY: ${{ secrets.FOUNDRY_API_KEY }}`); setz mit `llm.maxCalls` ein Budget. Ein kaputter Endpunkt
  lässt den Job mit Exit `2` fehlschlagen, bevor ein Browser startet, außer `llm.required` ist `false`. Siehe
  [LLM einrichten](llm-einrichten.md).
- **Einen CI-Befund lokal reproduzieren:** Lad das Artefakt herunter und spiel die `actions.json` des Laufs ab, siehe
  [Einen Befund reproduzieren](befund-reproduzieren.md).

## Nur neue Befunde: mit einer Baseline

Eine Seite mit vielen bekannten Befunden ließe jeden Lauf mit `1` enden. Mit einer Baseline scheitert er nur an neuen:

1. Lass den Monkey einmal laufen und kopier `baseline.json` aus dem Berichtsverzeichnis in dein Repository, z. B.
   neben die Konfiguration als `monkey-baseline.json`.
2. Trag sie in die Konfiguration ein: `"findings": { "baseline": "monkey-baseline.json" }` (relativ zur
   Konfigurationsdatei).
3. Ab jetzt endet `monkey run` mit `1` nur, wenn es einen Befund gibt, dessen Dedup-Schlüssel die Baseline nicht
   kennt (`exit 1: new findings present`); bekannte stehen weiter im Bericht, mit dem Abzeichen **known**.

Die Konsole sagt `baseline: 2 new, 5 known, 1 not seen this time`. „Not seen“ heißt nicht sicher „behoben“: Ein
Zufallslauf erreicht nicht jedes Mal jede Seite. Ist ein Fehler behoben oder ein neuer akzeptiert, kopier die
`baseline.json` des Laufs erneut; weil sie nach Schlüssel sortiert ist, zeigt der Diff im Pull Request genau, was sich
geändert hat. Fehlt die Datei oder ist sie kaputt, endet der Lauf mit `2`, bevor ein Browser startet.
