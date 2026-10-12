# Maintain the website

The website lives in `site/` as plain HTML and CSS, with no build step. It is published at
<https://besessener.github.io/PlayMonkey/>. It shares its layout and stylesheet with the Archivist and flakipype
pages; only the colour tokens at the top of `style.css` and the icon differ.

## Once: switch GitHub Pages on

1. Open the repository's Settings → Pages.
2. Under **Source**, choose **GitHub Actions**.

## Change the content

1. Edit `site/index.html` or `site/style.css`. A claim on the page must be true of the code; keep the status note
   current while features are missing.
2. Open `site/index.html` in a browser and check light and dark (the system colour scheme) and a phone-wide window.
3. Run `npm run lint`; Biome also checks the HTML, CSS and SVG.

As soon as a change under `site/` lands on `main`, the workflow `pages.yml` publishes it. To start it by hand:
Actions → Pages → **Run workflow**.
