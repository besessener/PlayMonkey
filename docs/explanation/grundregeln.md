# Grundregeln

PlayMonkey ist dafür gebaut, Dinge in Umgebungen kaputtzumachen, die zurückgesetzt werden. Diese Regeln prägen den
Entwurf.

## Nur Testumgebungen, keine Schutzgeländer

Es gibt keinen Nur-Lesen-Modus, keinen Filter für zerstörerische Aktionen und keine Bestätigung. Der Monkey klickt,
löscht und sendet alles ab, was er findet; so findet er Fehler. Richte ihn nur auf Testumgebungen, die du wegwerfen
kannst. Mit [`scope`](sitzungen.md#scope) kannst du ihn von Seiten fernhalten, um einen Lauf zu lenken; Anfragen per
`fetch` oder XHR hält der Scope nicht auf, er ist also kein Schutz.

## Läufe enden immer

`limits.maxSteps` und `limits.maxMinutes` beenden den Lauf jeder Rolle. `limits.maxMinutes` gilt auch mitten in einem
Schritt: Hängt ein Schritt (eine eingefrorene Seite, ein LLM, das nicht antwortet), endet der Lauf trotzdem
pünktlich. Jeder Aufruf an die Seite hat ein Zeitlimit; eine Seite, die nicht mehr antwortet, wird geschlossen und
ersetzt wie eine abgestürzte. Mit `stayOnDomain` (standardmäßig an) folgt
der Monkey keinen Navigationen zu anderen Origins und kann so nicht zu externen Seiten abwandern.

Auch ein unterbrochener Lauf endet geordnet: Strg+C (SIGINT), SIGTERM (etwa ein Timeout in der CI) oder SIGHUP halten
jeden Lauf nach dem aktuellen Schritt an. Danach schließt PlayMonkey selbst die Sitzungen und den Browser und schreibt
den Bericht mit den Befunden bis dahin. Playwrights eigene Signal-Handler sind deshalb abgeschaltet; sie würden den
Browser schließen und den Prozess beenden, bevor der Bericht geschrieben ist. Ein unterbrochener oder deswegen nicht
gestarteter Lauf gilt als nicht abgeschlossen und führt zu Exit-Code `2`, damit eine abgebrochene CI nie als „keine
Befunde“ durchgeht. Ein zweites Signal beendet den Prozess sofort, ohne Bericht.

## Secrets kommen aus der Umgebung und erscheinen nur maskiert

Zugangsdaten und Schlüssel stehen als Platzhalter `${VAR}` in der Konfiguration und werden beim Start aus
Umgebungsvariablen aufgelöst, nie aus Dateien gelesen. Jeder Wert, der so in die Anmeldefelder (`auth[].fields`), die
Testdaten (`testData`) oder `llm.apiKey` kommt, ist ein Secret und wird in Konsolenausgabe, Fehlermeldungen,
Aktionsprotokollen und Berichten als `***` maskiert. `${VAR}` an anderen Stellen, etwa für den Host in `baseUrl`, ist
gewöhnliche Konfiguration: Würde ein kurzer Wert wie `admin` oder `80` überall maskiert, würden Befunde,
Dedup-Schlüssel und Rollennamen unbrauchbar. Dedup-Schlüssel werden vor der Deduplizierung maskiert, nie danach.
Fehlermeldungen nennen den Konfigurationspfad und die Variable, nie einen Wert.

Ein Aktionsprotokoll entscheidet nie, welche Variablen eingesetzt werden: Replay löst nur die auf, die deine
Konfiguration verwendet, und nur auf dem Origin ihrer `baseUrl` (siehe
[Fremde Protokolle](replay.md#fremde-protokolle)).

Traces und Videos sind die Ausnahme: Playwright kann sie nicht schwärzen, und sie enthalten die Basis-URL, das
Sitzungs-Cookie, Request-Header und jeden Wert, den der Monkey eingetippt hat. Die bei einer Anmeldung eingetippten
Werte erreichen sie nie (die Anmeldung läuft in einem eigenen, nicht aufgezeichneten Browserkontext). Behandle
`trace.zip` und die Videos wie die Sitzungsdaten der Testumgebung; was genau sie enthalten, steht im
[Bericht](../reference/bericht.md#secrets).

## Rollen sind isoliert

Jeder Lauf (eine Rolle mit einem Seed) hat seinen eigenen Browserkontext, auch wenn Läufe parallel laufen. Cookies und
Speicher eines Laufs sind für einen anderen nie sichtbar. Läufe teilen sich nur den Browserprozess, die Testumgebung
selbst und, mit `llm`, das LLM-Budget und den Circuit Breaker.

## Neutral und generisch

Keine organisationsspezifischen Namen, kein Branding und keine URLs im Code oder in den Standardwerten; alles
Seitenspezifische steht in der Konfiguration.
