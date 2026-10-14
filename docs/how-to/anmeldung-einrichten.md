# Anmeldung einrichten

Jeder Eintrag in `auth` ist eine Rolle. PlayMonkey führt jede Rolle in einem eigenen Browserkontext aus; wie das
funktioniert, steht unter [Sitzungen und Anmeldung](../explanation/sitzungen.md).

## Über das Formular anmelden

```json
{
  "auth": [
    {
      "name": "admin",
      "loginUrl": "/login",
      "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" },
      "submit": "button[type=submit]"
    }
  ]
}
```

- `loginUrl` wird gegen `baseUrl` aufgelöst wie ein Link auf einer Seite unter `baseUrl`. Liegt deine Anwendung unter
  einem Pfad, z. B. `"baseUrl": "https://test.example.org/app"`, dann gilt:
  - `/app/login` (mit `/` am Anfang) ist relativ zum Origin: `https://test.example.org/app/login`. Das ist die sicherste
    Schreibweise.
  - `/login` landet auf `https://test.example.org/login`, außerhalb der Anwendung.
  - `login` (ohne `/`) ersetzt den letzten Pfadabschnitt: `https://test.example.org/login`. Endet `baseUrl` auf `/`
    (`https://test.example.org/app/`), wird daraus `https://test.example.org/app/login`.
  - Eine absolute URL gilt, wie sie ist.
- Jeder Schlüssel in `fields` findet genau ein Eingabefeld: als CSS-Selektor, wenn er wie einer aussieht
  (`input[name=user]`, `#pass`), sonst über das Attribut `name`, dann die `id`, dann die sichtbare Beschriftung. Er muss
  genau ein Element treffen.
- `submit` ist ein Selektor für den Button, der das Formular absendet; er muss genau ein Element treffen.

Nach dem Absenden gilt die Anmeldung als gescheitert, solange alle Felder aus `fields` noch sichtbar sind, auch wenn
die URL jetzt eine andere ist (ein Formular, das an `/session` geht und bei falschen Zugangsdaten dort wieder
erscheint). Sonst gilt sie als gelungen, wenn der Browser die Login-URL verlassen hat oder, bei einer Single-Page-App,
ein Cookie sich geändert hat und der Absende-Button verschwunden ist. Die Einzelheiten stehen unter
[Sitzungen und Anmeldung](../explanation/sitzungen.md#formular-anmeldung).

Verliert die Rolle ihre Sitzung mitten im Lauf, etwa weil der Monkey „Log out“ klickt, meldet PlayMonkey sie von selbst
wieder an; siehe [Verlorene Sitzung](../explanation/sitzungen.md#verlorene-sitzung).

## Gespeicherte Sitzung wiederverwenden

Lässt sich die Anmeldung nicht skripten (Single Sign-on, ein Einmalcode), meldest du dich einmal von Hand an und
speicherst den Storage State von Playwright, zum Beispiel mit einem kurzen Skript:

```ts
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://test.example.org/login");
await page.pause(); // log in in the browser window, then resume
await context.storageState({ path: "states/user.json" });
await browser.close();
```

Dann verweist du auf die Datei. Der Pfad ist relativ zur Konfigurationsdatei; `states/*.json` steht in `.gitignore`,
weil die Datei Sitzungscookies enthält.

```json
{ "auth": [{ "name": "user", "storageState": "./states/user.json" }] }
```

## Mehrere Rollen

Führ alle auf; die Namen müssen eindeutig sein. Jede Rolle läuft für sich, mit eigenen Cookies:

```json
{
  "auth": [
    { "name": "admin", "loginUrl": "/login", "fields": { "username": "${ADMIN_USER}", "password": "${ADMIN_PASS}" }, "submit": "button[type=submit]" },
    { "name": "user", "storageState": "./states/user.json" }
  ]
}
```

Ohne `auth` führt PlayMonkey eine anonyme Rolle aus. Damit die Rollen gleichzeitig statt nacheinander laufen, setz
`parallel`; siehe [Parallel ausführen](parallel-ausfuehren.md).

## Secrets aus der Datei heraushalten

Schreib `${VAR}` überall dort, wo ein Secret hingehört, und setz die Variable in der Umgebung (in der CI aus dem
Secret-Speicher). Eingesetzte Werte werden in jeder Ausgabe als `***` maskiert. Eine nicht gesetzte Variable beendet
den Lauf mit Exit-Code 2 und nennt den Konfigurationspfad und die Variable.

## Wenn die Anmeldung scheitert

Der Fehler nennt die Rolle und den Grund, nie einen Wert:

| Meldung | Prüfen |
| --- | --- |
| `login field "x" not found on /login` | Der Schlüssel trifft kein Element (oder mehrere). Nimm einen CSS-Selektor. |
| `submit selector "…" must match exactly one element` | Mach den Selektor genauer. |
| `login did not succeed: the login form is still shown at /session after submitting` | Zugangsdaten oder ein Captcha. |
| `login did not succeed: still on /login after submitting` | Zugangsdaten, Feldschlüssel oder ein Captcha. |
| `cannot read storageState file … (ENOENT)` | Den Pfad, relativ zur Konfigurationsdatei. |
| `… is not a Playwright storage state` | Die Datei muss JSON mit einem Array `cookies` sein. |
