import { layout } from "./html.ts";
import type { Response, Route } from "./pages.ts";

/**
 * Pages whose bugs stop a page or a connection: an error page with status 200, a route that never answers, a server
 * that drops the connection, a page that freezes, an unsaved-changes guard and a malformed link. Neither the home page
 * nor the lab links here, so other runs never reach these pages; tests start at `/lab/faults` or go to them directly.
 */
export const FAULT_PAGES: { path: string; link: string }[] = [
  { path: "/lab/faults/soft-404", link: "Old offer" },
  { path: "/lab/faults/slow", link: "Slow report" },
  { path: "/lab/faults/reset", link: "Unstable server" },
  { path: "/lab/faults/busy", link: "Busy page" },
  { path: "/lab/faults/guard", link: "Unsaved changes" },
  { path: "/lab/faults/bad-link", link: "Malformed link" },
];

const page = (title: string, body: string, status = 200): Response => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: layout(title, `<p><a href="/lab/faults">Back to the faults</a></p>\n${body}`),
});

const get = (path: string, handle: () => Response): Route => ({ method: "GET", path, handle });

export function faultRoutes(): Route[] {
  return [
    get("/lab/faults", () =>
      page(
        "Faults",
        `<ul>\n${FAULT_PAGES.map(({ path, link }) => `<li><a href="${path}">${link}</a></li>`).join("\n")}\n</ul>`,
      ),
    ),
    // Seeded bug: the page says "Not found" with status 200.
    get("/lab/faults/soft-404", () => page("Not found", "<p>This offer has expired.</p>")),
    get("/lab/faults/slow", () => page("Slow report", '<p><a href="/lab/faults/never">Open the report</a></p>')),
    // Seeded bug: the report never answers.
    get("/lab/faults/never", () => ({ status: 200, hold: true })),
    get("/lab/faults/reset", () => page("Unstable server", '<p><a href="/lab/faults/crash">Load the data</a></p>')),
    // Seeded bug: the server drops the connection before it answers.
    get("/lab/faults/crash", () => ({ status: 200, reset: true })),
    get("/lab/faults/busy", () =>
      page(
        "Busy page",
        `<button type="button" id="recalculate">Recalculate</button>
<script>
  // Seeded bug: the page freezes, on a click and on any key.
  const freeze = () => { for (;;) {} };
  document.getElementById("recalculate").addEventListener("click", freeze);
  document.addEventListener("keydown", () => setTimeout(freeze));
</script>`,
      ),
    ),
    get("/lab/faults/guard", () =>
      page(
        "Unsaved changes",
        `<label><input type="checkbox" id="dirty"> I changed something</label>
<script>
  // Not a bug: the page asks before it is left with unsaved changes.
  document.getElementById("dirty").addEventListener("change", () =>
    addEventListener("beforeunload", (event) => event.preventDefault()),
  );
</script>`,
      ),
    ),
    // Not a bug the monkey reports: a link whose address is no valid URL must not stop the run.
    get("/lab/faults/bad-link", () =>
      page("Malformed link", '<p><a href="http://">Broken address</a> <a href="/lab/faults/soft-404">Offer</a></p>'),
    ),
  ];
}
