# Sitzungen und Anmeldung

Es wird ein Browser gestartet (`browser.engine`, `browser.headless`). Jede Rolle bekommt ihren eigenen Browserkontext,
sodass Cookies und Speicher nie zwischen Rollen übergehen. Ohne Einträge in `auth` gibt es eine anonyme Rolle.

## Formular-Anmeldung

PlayMonkey öffnet `baseUrl + loginUrl`, füllt jedes Feld aus, klickt `submit` und entscheidet, ob die Anmeldung
geklappt hat:

- **Fehlschlag**, solange alle Felder aus `fields` noch sichtbar auf der Seite stehen, egal welche URL der Browser
  zeigt und ob sich ein Cookie geändert hat. Viele Anwendungen schicken das Formular an eine andere URL (`GET /login`,
  `POST /session`) und zeigen es bei falschen Zugangsdaten dort noch einmal an; die URL allein hielte das für einen
  Erfolg.
- **Erfolg** sonst, wenn die Seite die Login-URL verlassen hat (verglichen mit dem Ort, an dem der Browser tatsächlich
  gelandet ist, falls die Login-URL selbst weiterleitet), oder, bei Single-Page-Apps, die ohne Navigation anmelden,
  wenn sich ein Cookie geändert hat und der Absende-Button verschwunden ist.
- **Fehlschlag** in allen anderen Fällen. Der Versuch ist entschieden, sobald die nächste Seite lädt, sodass ein falsches Passwort
  sofort scheitert, statt auf einen Timeout zu warten. Nach der Empfehlung von Playwright wartet er auf die URL und
  das Load-Event, nicht auf „network idle“.

Die Anmeldung läuft in einem eigenen Kontext ohne Trace oder Video, und der Lauf startet mit dem dabei entstandenen
Storage State, sodass die eingetippten Werte nie in einer Aufzeichnung landen. Eine fehlgeschlagene Anmeldung ist
ein Werkzeugfehler (Exit-Code 2), dessen Meldung die Rolle und den Grund nennt, nie einen Wert.

## Gespeicherte Sitzungen

Eine Rolle mit `storageState` lädt eine Storage-State-Datei von Playwright. Die Datei wird zuerst geprüft (lesbar,
JSON, hat ein Array `cookies`), sodass ein Fehler eine klare Meldung ergibt statt eines Stack-Traces von Playwright.
Es wird keine Anmeldeanfrage gestellt.

## Verlorene Sitzung

Eine Sitzung kann mitten im Lauf verschwinden: Der Storage State ist abgelaufen, oder der Monkey klickt „Log out“.
Damit eine Rolle nicht unbemerkt als anonymer Besucher weiterläuft, prüft PlayMonkey bei jeder angemeldeten Rolle
nach jedem Schritt, ob der Schritt auf einer Anmeldeseite stattfand, auch ohne LLM. Als Anmeldeseite gilt der Pfad der
`loginUrl` einer Formular-Rolle oder eine Seite mit einem Passwortfeld und einem Button oder Link „Log in“, „Sign in“,
„Anmelden“ oder „Einloggen“.

Landet die Rolle dort, hält PlayMonkey ein Info-Event `session-lost` mit der maskierten URL fest, schreibt eine Warnung
ins Log und meldet die Rolle wieder an: Eine Formular-Rolle meldet sich wie beim Start in einem eigenen Kontext ohne
Trace oder Video an, eine Rolle mit `storageState` liest ihre Datei noch einmal. Die Cookies daraus kommen in den
Kontext des Laufs, und die Seite öffnet `baseUrl`, sodass der nächste Schritt angemeldet beginnt. `localStorage` wird
dabei nicht wiederhergestellt; eine Anwendung, die ihre Sitzung nur dort hält, bleibt abgemeldet.

Ein Event gibt es pro Ankunft auf einer Anmeldeseite, nicht pro Schritt dort. Eine erneute Anmeldung gilt als
gescheitert, wenn sie einen Fehler wirft oder der nächste Schritt wieder auf einer Anmeldeseite stattfindet. Nach drei
gescheiterten Versuchen in Folge versucht es PlayMonkey in diesem Lauf nicht mehr, schreibt das einmal ins Log und
lässt die Rolle abgemeldet weiterlaufen; der Lauf selbst bricht nie deswegen ab. Am Ende steht die Zahl der Verluste
im Log (`session lost 1 time`) und als `sessionLosses` im [Bericht](../reference/bericht.md).

Eine Anwendung, die ihre Anmeldeseite auch angemeldeten Besuchern zeigt, löst das ebenfalls aus, wenn der Monkey dort
hinklickt. Das kostet eine überflüssige Anmeldung und ein Event, aber keinen Befund. Mit LLM greift auf einer
Anmeldeseite zusätzlich der Auslöser `loginWall` (siehe [LLM](llm.md)).

## stayOnDomain

Eine Route auf dem Kontext bricht Navigationen der obersten Ebene zu einem anderen Origin ab und hält ein Info-Event
`blocked-navigation` fest; das ist kein Befund. Subressourcen von anderen Origins (CDNs, Schriften, APIs) laden
weiterhin, weil ihr Blockieren die meisten echten Seiten kaputtmachen würde.

Die Anfrage wird als `net::ERR_ABORTED` abgebrochen, was die Seite lässt, wo sie war. Andere Fehlercodes lassen die
Seite auf der Fehlerseite des Browsers, und eine Antwort mit 204 ließ den Klick von Playwright auf die Navigation
warten. Service Worker sind in diesem Modus blockiert, weil sie das Request-Routing umgehen; das Routing schaltet
außerdem den HTTP-Cache ab.

## scope

`scope.allow` und `scope.deny` sind reguläre Ausdrücke, die gegen die vollständige URL geprüft werden. Ist `allow`
nicht leer, darf der Monkey nur Seiten öffnen, deren URL zu einem Muster daraus passt; eine URL, die zu einem Muster
aus `deny` passt, öffnet er nie. So hältst du ihn von Seiten wie `/admin/delete-all` fern oder beschränkst einen Lauf
auf `/shop`. `baseUrl` muss im Scope liegen, sonst lehnt die Validierung die Konfiguration ab.

Der Scope wirkt an drei Stellen: Links außerhalb sind keine Kandidaten des Monkeys, `navigate` des LLM dorthin ist eine
ungültige Antwort, und dieselbe Route wie bei `stayOnDomain` bricht Navigationen der obersten Ebene dorthin ab
(`blocked-navigation`). Landet eine Seite trotzdem außerhalb, über eine Weiterleitung oder eine Navigation im Client,
die die Route nicht sieht, schickt der Lauf sie zurück zu `baseUrl`.

Der Scope gilt für Seiten, nicht für Anfragen: `fetch`, XHR und Subressourcen laufen weiter, auch an URLs aus `deny`.
Ein Button, der per `fetch` alles löscht, bleibt erreichbar; der Scope ist eine Steuerung, kein Schutzgeländer (siehe
[Grundregeln](grundregeln.md)).

## Trace und Video

Jede Rolle zeichnet einen Playwright-Trace mit Screenshots und DOM-Snapshots und ein Video der Seite auf. Beim
Schließen der Sitzung werden `trace.zip` (öffne ihn mit `npx playwright show-trace trace.zip`) und das Video unter
`video/` geschrieben. Beide sind im [Bericht](../reference/bericht.md) verlinkt und nicht maskiert; siehe dort den
Abschnitt über Secrets.
