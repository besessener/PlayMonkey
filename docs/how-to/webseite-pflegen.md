# Maintain the website

The website lives in `site/` as plain HTML and CSS, with no build step. It is published at
<https://besessener.github.io/PlayMonkey/>. It shares its layout, sections and stylesheet with the
[flakipype](https://besessener.github.io/flakipype/) and [Archivist](https://besessener.github.io/Archivist/) pages;
only the texts, images, icon and the colour tokens at the top of `style.css` differ. A change to the layout or to the
shared part of `style.css` goes to all three sites.

## Once: switch GitHub Pages on

1. Open the repository's Settings → Pages.
2. Under **Source**, choose **GitHub Actions**.

## Change the content

1. Edit `site/index.html` or `site/style.css`. Texts are English and match the [README](../../README.md) and the
   [ground rules](../explanation/grundregeln.md); a claim on the page must be true of the code. Keep the status note
   current while features are missing.
2. Open `site/index.html` in a browser and check light and dark (the system colour scheme) and a phone-wide window.
3. Run `npm run lint`; Biome also checks the HTML, CSS and SVG.

As soon as a change under `site/` lands on `main`, the workflow `pages.yml` publishes it. To start it by hand:
Actions → Pages → **Run workflow**.

## Refresh the screenshots

The terminal output in the hero and the images in `site/img/` come from a real run against the
[fixture site](fixture-seite-nutzen.md), so they show seeded bugs, never a real site:

1. Run the [getting started](../tutorials/erste-schritte.md) commands; copy the console output into the hero's
   terminal block, with the paths shortened to `fixtures/configs/…`.
2. Take a 1280 × 858 screenshot of `fixtures/configs/monkey-report/report.html` with Playwright, cropped to the
   1120 px wide content (x 80 to 1200), once with `colorScheme: "light"` into `site/img/report-light.png` and once
   with `"dark"` into `site/img/report-dark.png`.
