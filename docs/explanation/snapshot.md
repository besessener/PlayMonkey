# Seiten-Snapshots

Der Zufalls-Monkey und das LLM sehen die Seite auf dieselbe Weise: als Liste bedienbarer Elemente, jedes mit einer
kurzlebigen **Ref** wie `e8`, entnommen aus dem Accessibility-Snapshot von Playwright.

## Woher die Refs kommen

Playwright (seit 1.59) nimmt einen ARIA-Snapshot im „AI mode“ auf, der jedem Element eine Ref zuweist
(`page.ariaSnapshotJSON({ mode: "ai" })`, die strukturierte Form seit 1.63), und löst Refs mit `page.getByRef(ref)`
wieder in Elemente auf. PlayMonkey baut darauf auf, statt ein eigenes Elementregister zu führen:

- **Elemente:** Knoten mit einer interaktiven Rolle (link, button, textbox, checkbox, combobox, …) und alles, was die
  Seite als klickbar markiert (`cursor: pointer`). Jedes trägt Rolle, zugänglichen Namen, Linkziel, Platzhalter,
  Optionen einer Combobox, Zustand „checked“ und „expanded“, ob es aktiviert ist, ob es im Viewport liegt (aus seiner
  Bounding Box), ob es in einem Iframe liegt und ob es in einem offenen Dialog liegt (der Monkey bevorzugt solche,
  solange einer offen ist).
- **Offenes Shadow DOM** gehört zum Snapshot. **Same-Origin-Iframes** (auch `srcdoc` und `about:blank`) werden
  betreten; ihre Elemente lösen sich auf wie alle anderen. **Cross-Origin-Iframes** werden gezählt, nicht betreten:
  In ihnen zu handeln hieße, auf einem anderen Origin zu handeln.
- **Text:** statischer Text und die Namen von Überschriften und anderen nicht bedienbaren Knoten, in
  Dokumentreihenfolge.

## Refs sind kurzlebig

Eine Ref gehört zum neuesten ARIA-Snapshot der Seite. Ein neuer Snapshot behält die Refs von Elementen, die noch da
sind, aber eine Navigation nummeriert sie neu, und **jeder** andere ARIA-Snapshot der Seite (auch
`locator.ariaSnapshot()`) ersetzt die Menge. `resolve(page, ref)` prüft deshalb, dass die Ref auf genau ein Element
passt, und wirft sofort `StaleRefError`; Playwright selbst würde bis zu seinem Timeout auf das Element warten.

Weil Refs das Laden einer Seite nicht überleben, speichert das Aktionsprotokoll neben jeder Ref einen dauerhaften
Locator: `durableLocator(page, ref)` fragt Playwright nach dem Locator, den `codegen` schreiben würde, zum Beispiel
`getByRole('button', { name: 'Send' })`.

## Snapshot-Hash

Der Hash identifiziert einen Seitenzustand für die Erkennung des Feststeckens und das Aktionsprotokoll. Er ist ein
SHA-256 über den Snapshot-Baum, aus dem Refs, Bounding Boxes, Fokus und Cursor entfernt und in dem Leerraum
normalisiert ist. So bleibt er für eine unveränderte Seite gleich, über Neuladen und Läufe hinweg, und ändert sich,
wenn sich Inhalt oder Zustand eines Elements ändern (ein Abschnitt klappt auf, eine Checkbox wird angehakt). Er
enthält die URL nicht; der Monkey verfolgt Zustände als Paare (URL, Hash).

## Serialisieren für das LLM

`serializeSnapshot(snapshot, { maxChars })` gibt den Snapshot als schlichte Zeilen aus (`e8 textbox "Name"`),
innerhalb eines Zeichenbudgets (Standard 8000, etwa 2000 Tokens). Elemente im Viewport kommen zuerst, dann der Rest
in Dokumentreihenfolge; Namen werden gekürzt, der Seitentext bekommt höchstens ein Viertel des Budgets, wenn die
Elemente den Rest brauchen, und die Ausgabe sagt immer, was weggelassen wurde
(`[312 more elements omitted to fit the budget]`).

Der Serialisierer listet auch offene Dialoge auf (`Open dialogs: "Cookies"`); der Snapshot hält sie in `dialogs` für
die [Erkennung des Feststeckens](llm.md#wann-der-monkey-übergibt) fest.
