import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { FORM_MAX_LENGTH } from "../fixtures/site/pages.ts";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { parseConfig } from "../src/config/config.ts";
import { launchChromium } from "./helpers/browser.ts";

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  redirect: "manual" as const,
});

describe("fixture site over HTTP", () => {
  let site: Fixture;
  before(async () => {
    site = await startFixture();
  });
  after(() => site.close());

  function get(path: string): Promise<Response> {
    return fetch(site.url + path);
  }

  for (const path of ["/", "/login", "/form", "/js-error", "/console-error", "/overflow", "/clean"]) {
    it(`serves ${path}`, async () => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await response.text(), /<a href="\/">Home<\/a>/);
    });
  }

  it("links every page and the broken link from the home page", async () => {
    const home = await (await fetch(site.url)).text();
    for (const path of ["/login", "/account", "/form", "/js-error", "/console-error", "/overflow", "/clean"]) {
      assert.match(home, new RegExp(`href="${path}"`));
    }
    assert.match(home, /href="\/missing-page">Broken link</);
  });

  it("answers unknown paths with 404", async () => {
    assert.equal((await fetch(`${site.url}/missing-page`)).status, 404);
  });

  it("serves an empty favicon so browsers do not log a 404", async () => {
    assert.equal((await fetch(`${site.url}/favicon.ico`)).status, 204);
  });

  it("redirects /account to /login without a session", async () => {
    const response = await fetch(`${site.url}/account`, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login");
  });

  it("logs in with the test credentials and shows the account page", async () => {
    const login = await fetch(`${site.url}/login`, form({ ...FIXTURE_CREDENTIALS }));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/account");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^sid=/);

    const account = await fetch(`${site.url}/account`, { headers: { cookie } });
    assert.equal(account.status, 200);
    assert.match(await account.text(), /Signed in as <strong>monkey<\/strong>/);

    const logout = await fetch(`${site.url}/logout`, { ...form({}), headers: { ...form({}).headers, cookie } });
    assert.equal(logout.status, 303);
    assert.equal((await fetch(`${site.url}/account`, { headers: { cookie }, redirect: "manual" })).status, 303);
  });

  it("rejects wrong credentials with a message and no session", async () => {
    const response = await fetch(`${site.url}/login`, form({ username: "monkey", password: "wrong" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(await response.text(), /Invalid username or password/);
  });

  it("does not share sessions between fixture instances", async () => {
    const other = await startFixture();
    try {
      const login = await fetch(`${site.url}/login`, form({ ...FIXTURE_CREDENTIALS }));
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      assert.equal((await fetch(`${other.url}/account`, { headers: { cookie }, redirect: "manual" })).status, 303);
    } finally {
      await other.close();
    }
  });

  it("returns 500 for an empty name (seeded bug)", async () => {
    assert.equal((await fetch(`${site.url}/form`, form({ name: " ", email: "" }))).status, 500);
  });

  it("returns 500 for an overlong field (seeded bug)", async () => {
    const message = "x".repeat(FORM_MAX_LENGTH + 1);
    assert.equal((await fetch(`${site.url}/form`, form({ name: "Monkey", message }))).status, 500);
  });

  it("re-renders the form for an invalid email", async () => {
    const response = await fetch(`${site.url}/form`, form({ name: "Monkey", email: "nope" }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /valid email address/);
  });

  it("accepts a valid submission and escapes the echoed name", async () => {
    const response = await fetch(`${site.url}/form`, form({ name: "<script>alert(1)</script>", email: "a@b.cd" }));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes("<script>alert(1)"));
    assert.match(body, /Thanks, &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("frees the port on close", async () => {
    const temp = await startFixture();
    await temp.close();
    await assert.rejects(fetch(temp.url));
  });
});

describe("fixture site in a browser (click paths to each seeded bug)", () => {
  let site: Fixture;
  let browser: Browser;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** Opens the home page with listeners recording everything the oracles will look at. */
  async function openHome() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const events = { pageErrors: [] as string[], consoleErrors: [] as string[], badResponses: [] as string[] };
    page.on("pageerror", (error) => events.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") events.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        events.badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto(site.url);
    return { page, events };
  }

  function hasHorizontalOverflow(page: Page): Promise<boolean> {
    return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  }

  it("JS error: home -> JS error -> press the button", async () => {
    const { page, events } = await openHome();
    await page.getByRole("link", { name: "JS error" }).click();
    await Promise.all([page.waitForEvent("pageerror"), page.getByRole("button", { name: "Do not press" }).click()]);
    assert.deepEqual(events.pageErrors, ["Seeded bug: click handler crashed"]);
    await page.close();
  });

  it("broken link: home -> Broken link", async () => {
    const { page, events } = await openHome();
    await page.getByRole("link", { name: "Broken link" }).click();
    await page.waitForLoadState();
    assert.deepEqual(events.badResponses, ["404 /missing-page"]);
    await page.close();
  });

  it("HTTP 500: home -> Contact form -> Send without a name", async () => {
    const { page, events } = await openHome();
    await page.getByRole("link", { name: "Contact form" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForLoadState();
    assert.deepEqual(events.badResponses, ["500 /form"]);
    await page.close();
  });

  it("console error: home -> Console error", async () => {
    const { page, events } = await openHome();
    await page.getByRole("link", { name: "Console error" }).click();
    await page.waitForLoadState();
    assert.deepEqual(events.consoleErrors, ["Seeded bug: console error on load"]);
    await page.close();
  });

  it("overflow: home -> Overflow at the default 1280px viewport", async () => {
    const { page } = await openHome();
    assert.equal(await hasHorizontalOverflow(page), false);
    await page.getByRole("link", { name: "Overflow" }).click();
    await page.waitForLoadState();
    assert.equal(await hasHorizontalOverflow(page), true);
    await page.close();
  });

  it("login: home -> Log in -> fill the form -> account page", async () => {
    const { page, events } = await openHome();
    await page.getByRole("link", { name: "Log in" }).click();
    await page.getByLabel("Username").fill(FIXTURE_CREDENTIALS.username);
    await page.getByLabel("Password").fill(FIXTURE_CREDENTIALS.password);
    await page.locator("button[type=submit]").click();
    await page.waitForURL(`${site.url}/account`);
    assert.match((await page.locator("main").textContent()) ?? "", /Signed in as monkey/);
    assert.deepEqual(events, { pageErrors: [], consoleErrors: [], badResponses: [] });
    await page.close();
  });

  it("control: pages without seeded bugs produce no signals", async () => {
    const { page, events } = await openHome();
    for (const link of ["Clean page", "Log in", "Account", "Contact form"]) {
      await page.getByRole("link", { name: "Home" }).click();
      await page.getByRole("link", { name: link }).click();
      await page.waitForLoadState();
      assert.equal(await hasHorizontalOverflow(page), false, link);
    }
    await page.getByRole("link", { name: "Home" }).click();
    await page.getByRole("link", { name: "Clean page" }).click();
    await page.getByRole("button", { name: "Show details" }).click();
    await page.getByText("Nothing to see here.").waitFor();
    assert.deepEqual(events, { pageErrors: [], consoleErrors: [], badResponses: [] });
    await page.close();
  });
});

describe("fixtures/configs/fixture.json", () => {
  it("is a valid config once the fixture env vars are set", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL("../fixtures/configs/fixture.json", import.meta.url), "utf8");
    const { config } = parseConfig(text, {
      env: { FIXTURE_URL: "http://127.0.0.1:1", FIXTURE_USER: "monkey", FIXTURE_PASS: "banana-split" },
    });
    assert.equal(config.baseUrl, "http://127.0.0.1:1");
    assert.equal(config.auth[0]?.kind, "fields");
  });
});
