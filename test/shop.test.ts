import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { SHOP_COUPON } from "../demo/shop.ts";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { parseConfig } from "../src/config/config.ts";
import type { Action } from "../src/monkey/actions.ts";
import type { PlannedAction } from "../src/monkey/loop.ts";
import { runRole } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";

const form = (fields: Record<string, string>, cookie = "") => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams(fields).toString(),
  redirect: "manual" as const,
});

describe("demo shop over HTTP", () => {
  let site: Fixture;
  let cookie: string;
  before(async () => {
    site = await startFixture();
  });
  after(() => site.close());

  async function signIn(): Promise<string> {
    const login = await fetch(`${site.url}/demo/login`, form({ ...FIXTURE_CREDENTIALS }));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/demo/shop");
    return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const post = (path: string, fields: Record<string, string>) => fetch(`${site.url}${path}`, form(fields, cookie));
  const get = (path: string) => fetch(`${site.url}${path}`, { headers: { cookie }, redirect: "manual" });

  it("serves the landing page without linking to the main site, and the main site does not link here", async () => {
    const landing = await fetch(`${site.url}/demo`);
    assert.equal(landing.status, 200);
    const body = await landing.text();
    assert.match(body, /Monkey<span>Market<\/span>/);
    assert.doesNotMatch(body, /href="\/"/);
    assert.doesNotMatch(await (await fetch(site.url)).text(), /\/demo/);
  });

  it("asks for a sign-in before the shop and the cart", async () => {
    for (const path of ["/demo/shop", "/demo/cart"]) {
      const response = await fetch(`${site.url}${path}`, { redirect: "manual" });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/demo/login");
    }
    assert.equal((await fetch(`${site.url}/demo/checkout`, form({ coupon: "X" }))).status, 303);
  });

  it("rejects wrong credentials with a message and no session", async () => {
    const response = await fetch(`${site.url}/demo/login`, form({ username: "monkey", password: "wrong" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(await response.text(), /Wrong username or password/);
  });

  it("signs in, fills the cart within limits and places an order with the coupon", async () => {
    cookie = await signIn();
    assert.match(cookie, /^shop_sid=/);
    assert.equal((await get("/demo/login")).headers.get("location"), "/demo/shop");
    assert.match(await (await get("/demo/shop")).text(), /Hello, monkey/);
    assert.equal((await post("/demo/cart", { product: "banana", quantity: "50" })).status, 303);
    await post("/demo/cart", { product: "mango", quantity: "nope" });
    await post("/demo/cart", { product: "no-such-fruit", quantity: "1" });
    const cart = await (await get("/demo/cart")).text();
    assert.match(cart, /Cart <span class="pill">10<\/span>/);
    assert.match(cart, /Total €26\.40/);

    const invalid = await post("/demo/checkout", { email: "a@b.cd", coupon: "BANANA50" });
    assert.equal(invalid.status, 200);
    assert.match(await invalid.text(), /role="alert">This coupon code is not valid\./);
    const order = await post("/demo/checkout", {
      name: "<b>Monkey</b>",
      email: "a@b.cd",
      coupon: ` ${SHOP_COUPON.toLowerCase()} `,
    });
    assert.equal(order.status, 200);
    const text = await order.text();
    assert.match(text, /Thank you, &lt;b&gt;Monkey&lt;\/b&gt;!/);
    assert.match(text, /Order #1 .* You paid €23\.76\./);
    assert.match(await (await get("/demo/cart")).text(), /Your cart is empty/);
    assert.equal((await post("/demo/checkout", {})).headers.get("location"), "/demo/cart");
  });

  it("returns 500 for an email address without a domain (seeded bug)", async () => {
    await post("/demo/cart", { product: "kiwi", quantity: "1" });
    for (const email of ["", "monkey", "monkey@", "monkey@ "]) {
      assert.equal((await post("/demo/checkout", { email })).status, 500, email);
    }
    assert.equal((await post("/demo/checkout", { email: "monkey@test.local", coupon: "   " })).status, 200);
  });

  it("removes items and signs out", async () => {
    await post("/demo/cart", { product: "kiwi", quantity: "2" });
    await post("/demo/cart/remove", { product: "kiwi" });
    assert.match(await (await get("/demo/cart")).text(), /Your cart is empty/);
    assert.equal((await post("/demo/logout", {})).headers.get("location"), "/demo");
    assert.equal((await get("/demo/shop")).headers.get("location"), "/demo/login");
  });
});

const step = (action: Action, locator?: string): PlannedAction => ({
  action,
  source: "monkey",
  ...(locator === undefined ? {} : { locator }),
});
const click = (locator: string) => step({ type: "click", ref: "x" }, locator);
const fill = (name: string, value: string) =>
  step({ type: "fill", ref: "x", value }, `getByRole('textbox', { name: '${name}' })`);
const button = (name: string) => click(`getByRole('button', { name: '${name}' })`);
const link = (name: string) => click(`getByRole('link', { name: '${name}' })`);

describe("demo configs", () => {
  const read = async (name: string) => JSON.parse(await readFile(new URL(`../demo/${name}`, import.meta.url), "utf8"));

  it("ship the same demo for an OpenAI-compatible endpoint, apart from the LLM", async () => {
    const [foundry, openai] = await Promise.all([read("demo.json"), read("demo-openai.json")]);
    assert.deepEqual({ ...openai, llm: undefined }, { ...foundry, llm: undefined });
    assert.deepEqual(
      { ...openai.llm, provider: foundry.llm.provider, options: undefined },
      { ...foundry.llm, options: undefined },
    );
    assert.equal(openai.llm.provider, "openai");
    assert.deepEqual(openai.llm.options, { api: "chat" });
  });
});

describe("demo shop in a run with demo/demo.json", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-shop-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** Runs the shipped config without its LLM: scripted actions when given, else the seeded random monkey. */
  async function run(name: string, actions?: PlannedAction[]) {
    const json = JSON.parse(await readFile(new URL("../demo/demo.json", import.meta.url), "utf8"));
    // JSON.stringify drops the undefined llm: a run without an LLM, so tests never call a model.
    const loaded = parseConfig(JSON.stringify({ ...json, llm: undefined }), {
      env: { FIXTURE_URL: site.url },
      baseDir: dir,
    });
    const outcome = await runRole(browser, loaded.config.auth[0], loaded, {
      log: () => {},
      outputDir: join(dir, name),
      actionLog: false,
      ...(actions === undefined ? {} : { replay: { strict: true, actions } }),
    });
    assert.equal(outcome.error, undefined);
    return outcome;
  }

  const D2 = "accessibility|label-content-name-mismatch|/demo/shop";

  it("reports the checkout crash and the mislabelled buttons exactly once, however often they happen", async () => {
    const outcome = await run("bug", [
      link("Start shopping"),
      button("Add Bananas to cart"),
      button("Place order"),
      link("Back to the cart"),
      fill("Email", "monkey"),
      button("Place order"),
      click("getByRole('link', { name: 'Shop', exact: true })"),
    ]);
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? "no error");
    assert.deepEqual(
      outcome.findings.map((f) => [f.oracle, f.severity, f.key, f.step, f.occurrences]),
      [
        ["accessibility", "medium", D2, 1, 1],
        ["http5xx", "high", "http5xx|POST /demo/checkout 500", 3, 2],
      ],
    );
  });

  it("stays silent on every other page and on a valid order, apart from the shop page's labels", async () => {
    const outcome = await run("control", [
      link("Start shopping"),
      button("Add Mangoes to cart"),
      click("getByRole('link', { name: 'Shop', exact: true })"),
      step({ type: "fill", ref: "x", value: "3" }, "getByRole('spinbutton', { name: 'Quantity of Kiwis' })"),
      button("Add Kiwis to cart"),
      button("Remove Mangoes"),
      fill("Full name", "Monkey"),
      fill("Email", "monkey@test.local"),
      fill("Coupon code", "BANANA50"),
      button("Place order"),
      fill("Email", "monkey@test.local"),
      fill("Coupon code", SHOP_COUPON),
      button("Place order"),
      link("Keep shopping"),
      link("Cart 0"),
      link("Browse fruit"),
      click("getByRole('link', { name: 'monkey', exact: true })"),
      button("Sign out"),
      link("Sign in"),
    ]);
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? "no error");
    assert.deepEqual(
      outcome.findings.map((f) => f.key),
      [D2],
    );
  });

  it("finds the seeded bugs and nothing else with the config's seed", async () => {
    const outcome = await run("random");
    assert.equal(outcome.result?.stopReason, "maxSteps");
    assert.deepEqual(outcome.findings.map((f) => f.key).sort(), [D2, "http5xx|POST /demo/checkout 500"]);
  });
});
