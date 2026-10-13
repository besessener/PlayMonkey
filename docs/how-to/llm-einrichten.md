# LLM einrichten

Der Monkey läuft ohne LLM. Mit einem Abschnitt `llm` überlässt er die nächsten paar Entscheidungen einem Modell, wenn
er festgefahren ist; wann und wie, steht unter [Das LLM](../explanation/llm.md). Es gibt zwei Backends:

- **`anthropic-foundry`**: Claude-Modelle, in Microsoft Foundry bereitgestellt, angesprochen über den Foundry-Client
  des offiziellen Anthropic SDK (`@anthropic-ai/foundry-sdk`).
- **`openai`**: OpenAI-Modelle, in Microsoft Foundry bereitgestellt, oder jeder andere OpenAI-kompatible Endpunkt,
  angesprochen über das offizielle SDK `openai`.

## Claude auf Microsoft Foundry

1. Stell in deiner Foundry-Ressource ein Claude-Modell bereit (Foundry-Portal → model catalog → Deploy). Notier dir
   den **Deployment-Namen**; standardmäßig ist er die Modell-ID, er kann aber beliebig sein.
2. Kopier in den Details des Deployments die **Target URI** und den **Key**.
3. Konfiguriere:

   ```json
   "llm": {
     "provider": "anthropic-foundry",
     "baseUrl": "https://<resource>.services.ai.azure.com/anthropic",
     "deployment": "<deployment-name>",
     "apiKey": "${FOUNDRY_API_KEY}"
   }
   ```

   - `baseUrl` endet auf `/anthropic`. Das SDK hängt `/v1/messages` selbst an; eine aus dem Portal kopierte URL, die
     auf `/v1` oder `/v1/messages` endet, wird gekürzt, mit einem Hinweis.
   - `deployment` ist der Deployment-Name, der als Modell gesendet wird. Es ist keine Modell-ID eingebaut.
   - `apiKey` kommt aus der Umgebung; er wird überall maskiert und ist nie Teil eines Prompts oder einer
     Fehlermeldung.

4. Prüf es: `FOUNDRY_API_KEY=… monkey preflight config.json`.

Unterstützt werden nur API-Keys. Microsoft Entra ID lässt sich später als Alternative zu `apiKey` ergänzen, ohne
bestehende Konfigurationen zu ändern.

## OpenAI-Modelle und andere OpenAI-kompatible Endpunkte

1. Stell in deiner Foundry-Ressource ein Modell bereit und notier dir seinen **Deployment-Namen**.
2. Such die OpenAI-kompatible **Basis-URL** heraus. Sie hängt vom Endpunkt ab, deshalb wird sie vollständig
   konfiguriert und nie von PlayMonkey zusammengesetzt:

   | Endpunkt | Basis-URL |
   | --- | --- |
   | Azure OpenAI v1 auf der Ressource | `https://<resource>.openai.azure.com/openai/v1` |
   | Dasselbe auf einer Foundry-Ressource | `https://<resource>.services.ai.azure.com/openai/v1` |
   | Jeder andere OpenAI-kompatible Server | Was er dokumentiert, z. B. `https://api.openai.com/v1` |

3. Konfiguriere:

   ```json
   "llm": {
     "provider": "openai",
     "baseUrl": "https://<resource>.openai.azure.com/openai/v1",
     "deployment": "<deployment-name>",
     "apiKey": "${FOUNDRY_API_KEY}"
   }
   ```

   - Die v1-API braucht keine `api-version`; eine mit der URL kopierte Query wird verworfen, ebenso ein `/responses`
     oder `/chat/completions` am Ende (mit einem Hinweis), da das SDK den Pfad selbst anhängt.
   - Der Schlüssel wird als `Authorization: Bearer` gesendet, was Azure für API-Keys auf der v1-API akzeptiert.
   - `OPENAI_BASE_URL`, `OPENAI_ORG_ID` und `OPENAI_PROJECT_ID` in der Umgebung werden ignoriert: Nur die
     Konfiguration entscheidet, wohin Anfragen gehen.

4. Prüf es: `FOUNDRY_API_KEY=… monkey preflight config.json`.

### Responses API oder Chat Completions

Microsoft empfiehlt für Azure-OpenAI-Modelle die **Responses API**, und sie ist der Standard. Modelle anderer
Anbieter auf Foundry und viele selbst betriebene OpenAI-kompatible Server bieten nur **Chat Completions**; umstellen
kannst du mit:

```json
"options": { "api": "chat" }
```

Beide nutzen Function Calling mit denselben Werkzeugen; PlayMonkey erzwingt keine Werkzeugwahl und prüft jeden Aufruf
selbst, deshalb werden die Werkzeuge ohne den `strict`-Modus von OpenAI gesendet. Die Responses API wird mit
`store: false` aufgerufen, damit Prompts (die Seiteninhalte enthalten) nicht auf dem Server bleiben. Antwortet der
Preflight auf der einen Schnittstelle mit `notFound` oder `badRequest`, versuch die andere.

`llm.options.effort` wird als Reasoning Effort gesendet (`reasoning.effort`, `reasoning_effort`); `thinking` gilt nur
für Claude und wird mit `openai` abgelehnt. OpenAI cacht lange Prompt-Präfixe automatisch; Cache-Lesezugriffe
erscheinen als `cachedTokens`.

## Budget und Kosten

LLM-Aufrufe kosten Geld und Zeit, deshalb fragt der Monkey nur, wenn er festgefahren ist, und du kannst einen Lauf
begrenzen:

```json
"llm": {
  "...": "...",
  "maxCalls": 200,
  "maxTokens": 2000000,
  "pricing": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3 }
}
```

Ist ein Budget aufgebraucht, läuft der Lauf als reiner Monkey weiter, und Konsole und Bericht sagen, wann das passiert
ist. `pricing` macht aus Tokenzahlen **geschätzte** Kosten im Bericht; nimm die Preise deines Deployments aus deinem
Azure-Vertrag, eine eingebaute Preisliste gibt es nicht. Die [LLM-Nutzung](../reference/bericht.md#llm) im Bericht
zeigt Aufrufe, Tokens, Cache-Lesezugriffe, Wiederholungen, Fallbacks und Latenz je Rolle.

## Thinking und Effort

Dieser Abschnitt gilt für `anthropic-foundry`; für `openai` siehe
[Responses API oder Chat Completions](#responses-api-oder-chat-completions).

Neuere Claude-Modelle denken standardmäßig nach, bevor sie antworten, und manche lehnen das Abschalten ab. PlayMonkey
sendet deshalb keine Einstellung für `thinking`, solange du keine wählst, und Thinking-Tokens zählen gegen
`llm.options.maxOutputTokens` (Standard 4096) und werden als Ausgabe abgerechnet. Damit Entscheidungen auf einem
Modell, das es erlaubt, schneller und günstiger werden:

```json
"options": { "thinking": "disabled", "effort": "low" }
```

Welche Kombinationen ein Modell akzeptiert, steht in Anthropics
[Dokumentation zu Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking); eine abgelehnte
Einstellung zeigt sich im Preflight als `badRequest`.

## Fehlerbehebung

`monkey run` führt den Preflight vor jeder Browserarbeit aus; `monkey preflight` führt nur ihn aus. Die Probe bittet
das Modell, ein Werkzeug `ping` aufzurufen, und prüft, dass ein wohlgeformter Werkzeugaufruf zurückkommt. Ein Fehler
gibt den Anbieter, die URL ohne Zugangsdaten und Query, den HTTP-Status, die Ursache und einen Hinweis aus und endet
mit Exit-Code `2`. Mit `"required": false` warnt der Lauf stattdessen und läuft als reiner Zufalls-Monkey weiter.

| Ursache | Typischer Status | Prüfen |
| --- | --- | --- |
| `unreachable` | – | `llm.baseUrl`, DNS, Proxy und Firewall. |
| `tls` | – | Die Zertifikatskette; hinter einem Proxy, der TLS aufbricht, setz `NODE_EXTRA_CA_CERTS`. |
| `timeout` | – | Das Netzwerk, oder erhöhe `llm.timeoutMs`. |
| `auth` | 401 | `llm.apiKey` muss ein Schlüssel dieser Ressource sein. |
| `forbidden` | 403 | Die Identität braucht eine Rolle wie **Foundry User** (früher Azure AI User) auf der Ressource; für `openai` **Cognitive Services OpenAI User**. |
| `notFound` | 404 | `llm.deployment` muss der Deployment-Name sein, nicht die Modell-ID; `llm.baseUrl` muss auf `/anthropic` enden (`anthropic-foundry`) oder die vollständige Basis-URL sein, etwa `…/openai/v1` (`openai`). Mit `openai` bietet das Deployment diese API-Schnittstelle vielleicht nicht an: versuch `llm.options.api`. |
| `rateLimited` | 429 | Warte, oder erhöhe das Kontingent des Deployments. Anfragen werden vorher `llm.maxRetries`-mal wiederholt. |
| `badRequest` | 400 | Ein Wert in `llm.options`, den das Modell nicht akzeptiert; mit `openai` auch eine API-Schnittstelle oder Werkzeugaufrufe, die das Deployment nicht unterstützt. |
| `server` | 5xx | Der Endpunkt hatte ein Problem; versuch es später noch einmal. |
| `invalid` | 200 | Das Modell hat ohne gültigen Werkzeugaufruf geantwortet: Werkzeugaufrufe werden auf diesem Endpunkt nicht unterstützt oder sind kaputt. |

Für alles andere schreibt `llm.debugLog: true` jeden Prompt und jede Antwort in `llm-debug.jsonl` im
Berichtsverzeichnis.
