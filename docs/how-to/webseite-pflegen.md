# Webseite pflegen

Die Webseite liegt unter `site/` als reines HTML und CSS, ohne Build-Schritt. Sie erscheint auf
<https://besessener.github.io/PlayMonkey/>. Aufbau, Abschnitte und Stylesheet teilt sie mit den Seiten von
[flakipype](https://besessener.github.io/flakipype/), [Archivist](https://besessener.github.io/Archivist/) und
[WOMBOT](https://besessener.github.io/WOMBOT/); nur Texte, Bilder, Icon und die Farbtokens oben in `style.css`
unterscheiden sich. Eine Änderung am Aufbau oder am gemeinsamen Teil von `style.css` gehört in alle vier Seiten.

## Einmalig: GitHub Pages einschalten

1. Öffne im Repository Settings → Pages.
2. Wähle unter **Source** den Eintrag **GitHub Actions**.

## Inhalt ändern

1. Bearbeite `site/index.html` oder `site/style.css`. Texte sind Deutsch, sprechen dich mit „du“ an und passen zur
   [README](../../README.md) und zu den [Grundregeln](../explanation/grundregeln.md); was die Seite verspricht, muss
   der Code halten. Halte den Stand-Hinweis aktuell, solange Funktionen fehlen.
2. Öffne `site/index.html` im Browser und prüfe Hell und Dunkel (Farben des Systems) und ein handybreites Fenster.
3. Führe `npm run lint` aus; Biome prüft auch HTML, CSS und SVG.

Sobald eine Änderung unter `site/` auf `main` landet, veröffentlicht der Workflow `pages.yml` die Seite. Von Hand
startest du ihn unter Actions → Pages → **Run workflow**.

## Screenshots erneuern

Die Terminalausgabe im Hero und die Bilder in `site/img/` stammen aus einem echten Lauf gegen die
[Fixture-Seite](fixture-seite-nutzen.md); sie zeigen also absichtlich eingebaute Fehler, nie eine echte Seite:

1. Führ die Befehle aus [Erste Schritte](../tutorials/erste-schritte.md) aus; kopier die Konsolenausgabe in den
   Terminalblock des Heros, mit auf `fixtures/configs/…` gekürzten Pfaden.
2. Nimm mit Playwright einen Screenshot von `fixtures/configs/monkey-report/report.html` in 1280 × 858 auf,
   zugeschnitten auf den 1120 px breiten Inhalt (x 80 bis 1200), einmal mit `colorScheme: "light"` nach
   `site/img/report-light.png` und einmal mit `"dark"` nach `site/img/report-dark.png`.
