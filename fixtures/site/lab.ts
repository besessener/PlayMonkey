import { layout } from "./html.ts";
import type { Request, Response, Route } from "./pages.ts";

/**
 * The lab: pages for the hard parts of real sites (consent banners, native dialogs, iframes, popups, file inputs,
 * downloads, hover menus and other widgets). The home page does not link here, so runs from `/` never reach it and
 * the five seeded bugs of the main site stay exactly five; start at `/lab` to include it. `/lab` links back to `/`.
 */
export const LAB_PAGES: { path: string; link: string }[] = [
  { path: "/lab/consent", link: "Cookie banner" },
  { path: "/lab/dialogs", link: "Native dialogs" },
  { path: "/lab/alert-on-load", link: "Alert on load" },
  { path: "/lab/frames", link: "Frames" },
  { path: "/lab/popups", link: "Popups" },
  { path: "/lab/upload", link: "Upload" },
  { path: "/lab/download", link: "Download" },
  { path: "/lab/widgets", link: "Widgets" },
  { path: "/lab/news", link: "News" },
];

/** Bytes of the broken download that arrive before the connection drops (seeded bug). */
export const BROKEN_DOWNLOAD_BYTES = 64;

const html = (body: string, status = 200): Response => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});

const page = (title: string, body: string): Response =>
  html(layout(title, `<p><a href="/lab">Back to the lab</a></p>\n${body}`));

/** The same server under another origin: `localhost` instead of `127.0.0.1`, for a cross-origin iframe. */
function otherOrigin(request: Request): string {
  return `http://localhost:${request.host.split(":")[1] ?? "80"}`;
}

// A full-screen consent overlay hides the page until it is answered; the answer is kept in a cookie.
const CONSENT_BODY = `<p>Today's offers are behind the banner.</p>
<button type="button" id="offers" aria-expanded="false">Show offers</button>
<p id="list" hidden>Bananas, half price.</p>
<div id="consent" role="dialog" aria-modal="true" aria-label="Cookie consent" hidden
  style="position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center;">
  <div style="background: white; padding: 2rem; max-width: 30rem;">
    <p>We use cookies for tracking. Do you consent?</p>
    <button type="button" data-answer="yes">Accept all</button>
    <button type="button" data-answer="no">Reject all</button>
  </div>
</div>
<script>
  const consent = document.getElementById("consent");
  if (!document.cookie.includes("consent=")) consent.hidden = false;
  for (const button of consent.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      document.cookie = "consent=" + button.dataset.answer + "; path=/";
      consent.hidden = true;
    });
  }
  const offers = document.getElementById("offers");
  offers.addEventListener("click", () => {
    const list = document.getElementById("list");
    list.hidden = !list.hidden;
    offers.setAttribute("aria-expanded", String(!list.hidden));
  });
</script>`;

const DIALOGS_BODY = `<button type="button" id="alert">Show alert</button>
<button type="button" id="confirm">Delete everything</button>
<button type="button" id="prompt">Rename</button>
<label><input type="checkbox" id="guard"> Warn before leaving</label>
<p id="result" role="status">Nothing happened yet.</p>
<script>
  const result = document.getElementById("result");
  document.getElementById("alert").addEventListener("click", () => {
    alert("Hello from the lab");
    result.textContent = "Alert closed.";
  });
  document.getElementById("confirm").addEventListener("click", () => {
    result.textContent = confirm("Really delete everything?") ? "Deleted." : "Kept.";
  });
  document.getElementById("prompt").addEventListener("click", () => {
    const name = prompt("New name?", "monkey");
    result.textContent = name === null ? "Not renamed." : "Renamed to " + name + ".";
  });
  const guard = (event) => event.preventDefault();
  document.getElementById("guard").addEventListener("change", (event) => {
    if (event.target.checked) addEventListener("beforeunload", guard);
    else removeEventListener("beforeunload", guard);
  });
</script>`;

const UPLOAD_BODY = `<label>Document <input type="file" id="document"></label>
<label>Attachments <input type="file" id="attachments" multiple></label>
<input type="file" id="avatar" accept="image/*" hidden>
<button type="button" id="pick">Upload avatar</button>
<ul id="files" aria-label="Chosen files"></ul>
<script>
  const list = document.getElementById("files");
  const show = (event) => {
    for (const file of event.target.files) {
      const item = document.createElement("li");
      item.textContent = event.target.id + ": " + file.name + " (" + file.size + " bytes)";
      list.append(item);
    }
  };
  for (const input of document.querySelectorAll("input[type=file]")) input.addEventListener("change", show);
  document.getElementById("pick").addEventListener("click", () => document.getElementById("avatar").click());
</script>`;

const WIDGETS_BODY = `<style>
  .menu .submenu { display: none; }
  .menu:hover .submenu, .menu:focus-within .submenu { display: block; }
  #board { display: flex; gap: 1rem; }
  #board [draggable] { border: 1px solid #888; padding: .5rem; cursor: grab; }
  #done { border: 2px dashed #888; min-width: 8rem; min-height: 3rem; padding: .5rem; }
</style>
<div class="menu"><button type="button">Products</button>
  <ul class="submenu"><li><a href="/lab/widgets?item=apples">Apples</a></li><li><a href="/lab/widgets?item=pears">Pears</a></li></ul>
</div>
<p><span role="button" tabindex="0" id="title">Double-click to edit</span></p>
<p><span role="button" tabindex="0" id="context">Right-click for options</span></p>
<ul id="options" role="menu" aria-label="Options" hidden><li role="menuitem" tabindex="-1">Copy</li><li role="menuitem" tabindex="-1">Paste</li></ul>
<div id="board">
  <span role="button" tabindex="0" draggable="true" id="card-a">Card A</span>
  <span role="button" tabindex="0" draggable="true" id="card-b">Card B</span>
  <div id="done" role="region" aria-label="Done">Done: <span id="count">0</span></div>
</div>
<p><button type="button" id="hold">Hold to confirm</button></p>
<p id="status" role="status"></p>
<script>
  const status = document.getElementById("status");
  const title = document.getElementById("title");
  title.addEventListener("dblclick", () => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Title");
    input.value = title.textContent;
    title.replaceWith(input);
    input.focus();
  });
  const options = document.getElementById("options");
  document.getElementById("context").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    options.hidden = false;
  });
  for (const item of options.children) item.addEventListener("click", () => {
    status.textContent = item.textContent + " chosen.";
    options.hidden = true;
  });
  const done = document.getElementById("done");
  for (const card of document.querySelectorAll("[draggable]")) {
    card.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", card.id));
  }
  done.addEventListener("dragover", (event) => event.preventDefault());
  done.addEventListener("drop", (event) => {
    event.preventDefault();
    const card = document.getElementById(event.dataTransfer.getData("text/plain"));
    if (card !== null) {
      card.remove();
      document.getElementById("count").textContent = String(done.dataset.count = Number(done.dataset.count ?? 0) + 1);
    }
  });
  let timer;
  const hold = document.getElementById("hold");
  hold.addEventListener("pointerdown", () => {
    timer = setTimeout(() => { status.textContent = "Confirmed."; }, 500);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) hold.addEventListener(type, () => clearTimeout(timer));
</script>`;

// Seeded bug: the request is never checked for failure, so without a network the rejection goes uncaught.
const NEWS_BODY = `<button type="button" id="load">Load news</button>
<p id="news" role="status">No news loaded.</p>
<script>
  document.getElementById("load").addEventListener("click", async () => {
    const response = await fetch("/lab/news.json");
    document.getElementById("news").textContent = (await response.json()).headline;
  });
</script>`;

function labPage(path: string, title: string, body: string): Route {
  return { method: "GET", path, handle: () => page(title, body) };
}

function labIndex(): Response {
  const links = LAB_PAGES.map(({ path, link }) => `<li><a href="${path}">${link}</a></li>`);
  links.push('<li><a href="/">Main site</a></li>');
  return html(layout("Monkey lab", `<ul>\n${links.join("\n")}\n</ul>`));
}

/** The lab index, overlays, native dialogs and frames. */
function dialogAndFrameRoutes(): Route[] {
  return [
    { method: "GET", path: "/lab", handle: labIndex },
    labPage("/lab/consent", "Cookie banner", CONSENT_BODY),
    labPage("/lab/dialogs", "Native dialogs", DIALOGS_BODY),
    // The alert blocks the load event until it is answered.
    labPage(
      "/lab/alert-on-load",
      "Alert on load",
      `<p>An alert greets every visitor.</p>\n<script>alert("Welcome to the lab");</script>`,
    ),
    {
      method: "GET",
      path: "/lab/frames",
      handle: (request) =>
        page(
          "Frames",
          `<p>A same-origin frame, an inline frame and a frame from another origin.</p>
<iframe src="/lab/frame-inner" title="Inner frame" width="400" height="120"></iframe>
<iframe srcdoc="<button type=button onclick=&quot;this.textContent='Pressed'&quot;>Press me</button>" title="Inline frame" width="200" height="60"></iframe>
<iframe src="${otherOrigin(request)}/lab/frame-outside" title="Other origin" width="300" height="60"></iframe>`,
        ),
    },
    {
      method: "GET",
      path: "/lab/frame-inner",
      handle: () =>
        html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Inner frame</title><link rel="icon" href="data:,"></head>
<body>
<button type="button" id="crash">Crash in frame</button>
<script>
  // Seeded bug: uncaught exception in a click handler inside an iframe.
  document.getElementById("crash").addEventListener("click", () => {
    throw new Error("Seeded bug: frame handler crashed");
  });
</script>
</body></html>`),
    },
    {
      method: "GET",
      path: "/lab/frame-outside",
      handle: () =>
        html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Other origin</title><link rel="icon" href="data:,"></head>
<body><button type="button">Out of reach</button></body></html>`),
    },
  ];
}

/** Popups, file inputs, downloads and widgets. */
function popupFileAndWidgetRoutes(): Route[] {
  return [
    labPage(
      "/lab/popups",
      "Popups",
      `<p><a href="/lab/popup-inner" target="_blank">Details in a new tab</a></p>
<p><a href="https://example.invalid/" target="_blank" rel="noopener">External site</a></p>
<button type="button" id="window">Open a window</button>
<button type="button" id="closing">Open a window that closes itself</button>
<script>
  document.getElementById("window").addEventListener("click", () => window.open("/lab/popup-inner?via=script"));
  document.getElementById("closing").addEventListener("click", () => window.open("/lab/popup-closing"));
</script>`,
    ),
    labPage(
      "/lab/popup-inner",
      "Popup",
      `<p>Opened in a new tab.</p>
<script>
  // Seeded bug: the popup's script fails while loading.
  throw new Error("Seeded bug: popup failed to initialise");
</script>`,
    ),
    labPage(
      "/lab/popup-closing",
      "Closing",
      "<p>This window closes itself.</p>\n<script>setTimeout(() => close(), 100);</script>",
    ),
    labPage("/lab/upload", "Upload", UPLOAD_BODY),
    labPage(
      "/lab/download",
      "Download",
      `<p><a href="/lab/files/report.csv">Download the report</a></p>
<p><a href="/lab/files/export.zip">Download the export</a></p>`,
    ),
    {
      method: "GET",
      path: "/lab/files/report.csv",
      handle: () => ({
        status: 200,
        headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' },
        body: "fruit,price\nbanana,1\napple,2\n",
      }),
    },
    {
      method: "GET",
      path: "/lab/files/export.zip",
      // Seeded bug: the connection drops in the middle of the download.
      handle: () => ({
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="export.zip"',
          "content-length": "100000",
        },
        body: "x".repeat(BROKEN_DOWNLOAD_BYTES),
        abort: true,
      }),
    },
    labPage("/lab/widgets", "Widgets", WIDGETS_BODY),
    labPage("/lab/news", "News", NEWS_BODY),
    {
      method: "GET",
      path: "/lab/news.json",
      handle: () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headline: "Bananas are back in stock" }),
      }),
    },
  ];
}

export function labRoutes(): Route[] {
  return [...dialogAndFrameRoutes(), ...popupFileAndWidgetRoutes()];
}
