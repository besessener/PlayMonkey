import { randomUUID } from "node:crypto";
import { escapeHtml, layout } from "./html.ts";
import { labRoutes } from "./lab.ts";

export interface Credentials {
  username: string;
  password: string;
}

export interface Request {
  method: string;
  url: URL;
  /** The `Host` header, e.g. `127.0.0.1:41234`. */
  host: string;
  cookies: Record<string, string>;
  /** Parsed `application/x-www-form-urlencoded` body of a POST. */
  form: URLSearchParams;
}

export interface Response {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Drop the connection after sending `body`, although the headers promised more (a broken download). */
  abort?: boolean;
}

export interface Route {
  method: "GET" | "POST";
  path: string;
  /** Link text on the home page; routes without one are not linked from home. */
  link?: string;
  handle: (request: Request) => Response;
}

/** Per-server state, so parallel fixture instances never share sessions. */
export interface SiteState {
  credentials: Credentials;
  sessions: Map<string, string>;
}

const SESSION_COOKIE = "sid";

/** Field values longer than this crash the form handler (seeded bug). */
export const FORM_MAX_LENGTH = 1000;

const html = (body: string, status = 200): Response => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});

const redirect = (location: string, headers: Record<string, string> = {}): Response => ({
  status: 303,
  headers: { location, ...headers },
});

export function notFound(): Response {
  return html(layout("Not found", "<p>This page does not exist.</p>"), 404);
}

export function serverError(): Response {
  return html(layout("Internal Server Error", "<p>Something went wrong.</p>"), 500);
}

function loginForm(error?: string): string {
  return `${error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>`}
<form method="post" action="/login">
  <label>Username <input name="username" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Log in</button>
</form>`;
}

function contactForm(errors: string[] = []): string {
  const list = errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("");
  // novalidate: the browser must not block submissions, so the server-side bug stays reachable.
  return `${list === "" ? "" : `<ul class="error" role="alert">${list}</ul>`}
<form method="post" action="/form" novalidate>
  <label>Name <input name="name"></label>
  <label>Email <input name="email" type="email"></label>
  <label>Topic
    <select name="topic">
      <option value="question">Question</option>
      <option value="bug">Bug report</option>
      <option value="other">Other</option>
    </select>
  </label>
  <label><input name="subscribe" type="checkbox" value="yes"> Subscribe to the newsletter</label>
  <label>Message <textarea name="message" rows="4"></textarea></label>
  <button type="submit">Send</button>
</form>`;
}

/** A GET page with a fixed body inside the common layout. */
function staticPage(path: string, link: string, title: string, body: string): Route {
  return { method: "GET", path, link, handle: () => html(layout(title, body)) };
}

function currentUser(state: SiteState, request: Request): string | undefined {
  const sid = request.cookies[SESSION_COOKIE];
  return sid === undefined ? undefined : state.sessions.get(sid);
}

function homePage(routes: Route[]): Response {
  const links = routes
    .filter((route) => route.link !== undefined)
    .map((route) => `<li><a href="${route.path}">${escapeHtml(route.link ?? "")}</a></li>`);
  // Seeded bug: a broken internal link.
  links.push('<li><a href="/missing-page">Broken link</a></li>');
  return html(layout("PlayMonkey fixture", `<ul>\n${links.join("\n")}\n</ul>`));
}

function logIn(state: SiteState, request: Request): Response {
  const { username, password } = state.credentials;
  if (request.form.get("username") !== username || request.form.get("password") !== password) {
    // 200 with a message, like most real apps; a 401 here would be an unseeded http4xx finding.
    return html(layout("Log in", loginForm("Invalid username or password.")));
  }
  const sid = randomUUID();
  state.sessions.set(sid, username);
  return redirect("/account", { "set-cookie": `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax` });
}

function accountPage(state: SiteState, request: Request): Response {
  const user = currentUser(state, request);
  if (user === undefined) return redirect("/login");
  return html(
    layout(
      "Account",
      `<p>Signed in as <strong>${escapeHtml(user)}</strong>.</p>
<form method="post" action="/logout"><button type="submit">Log out</button></form>`,
    ),
  );
}

function logOut(state: SiteState, request: Request): Response {
  const sid = request.cookies[SESSION_COOKIE];
  if (sid !== undefined) state.sessions.delete(sid);
  return redirect("/", { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
}

function submitContactForm(request: Request): Response {
  const values = [...request.form.values()];
  // Seeded bug: an empty name or an overlong field crashes the handler.
  if ((request.form.get("name") ?? "").trim() === "" || values.some((v) => v.length > FORM_MAX_LENGTH)) {
    return serverError();
  }
  const email = request.form.get("email") ?? "";
  if (email !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return html(layout("Contact form", contactForm(["Please enter a valid email address."])));
  }
  const name = request.form.get("name") ?? "";
  return html(layout("Thank you", `<p>Thanks, ${escapeHtml(name)}. We will get back to you.</p>`));
}

/** Log in, account, log out and the contact form. */
function formRoutes(state: SiteState): Route[] {
  return [
    staticPage("/login", "Log in", "Log in", loginForm()),
    { method: "POST", path: "/login", handle: (request) => logIn(state, request) },
    { method: "GET", path: "/account", link: "Account", handle: (request) => accountPage(state, request) },
    { method: "POST", path: "/logout", handle: (request) => logOut(state, request) },
    staticPage("/form", "Contact form", "Contact form", contactForm()),
    { method: "POST", path: "/form", handle: submitContactForm },
  ];
}

/** Pages with one seeded bug each, and the clean control page. */
function bugPageRoutes(): Route[] {
  return [
    staticPage(
      "/js-error",
      "JS error",
      "JS error",
      `<p>Pressing the button runs a broken click handler.</p>
<button type="button" id="crash">Do not press</button>
<script>
  // Seeded bug: uncaught exception in a click handler.
  document.getElementById("crash").addEventListener("click", () => {
    throw new Error("Seeded bug: click handler crashed");
  });
</script>`,
    ),
    staticPage(
      "/console-error",
      "Console error",
      "Console error",
      `<p>This page logs an error while loading.</p>
<script>
  // Seeded bug: console.error on load.
  console.error("Seeded bug: console error on load");
</script>`,
    ),
    staticPage(
      "/overflow",
      "Overflow",
      "Overflow",
      // Seeded bug: a fixed-width element wider than common viewports causes horizontal overflow.
      `<div style="width: 1600px; background: #ffe08a; padding: 1rem;">This banner is wider than the viewport.</div>`,
    ),
    staticPage(
      "/clean",
      "Clean page",
      "Clean page",
      `<p>This page has no bugs. It is the control: the monkey must not report anything here.</p>
<label>Search <input name="q" type="search"></label>
<button type="button" id="toggle" aria-expanded="false">Show details</button>
<p id="details" hidden>Nothing to see here.</p>
<script>
  const toggle = document.getElementById("toggle");
  const details = document.getElementById("details");
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    toggle.setAttribute("aria-expanded", String(!details.hidden));
  });
</script>`,
    ),
  ];
}

/**
 * All routes of the fixture site. To add a page, add an entry to one of the route groups (with `link` to list it on
 * the home page) and document any seeded bug in fixtures/README.md.
 */
export function createRoutes(state: SiteState): Route[] {
  const routes: Route[] = [
    { method: "GET", path: "/", handle: () => homePage(routes) },
    { method: "GET", path: "/favicon.ico", handle: () => ({ status: 204 }) },
    ...formRoutes(state),
    ...bugPageRoutes(),
    ...labRoutes(),
  ];
  return routes;
}
