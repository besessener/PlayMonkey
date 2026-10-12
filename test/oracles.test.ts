import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { type Config, parseConfig } from "../src/config/config.ts";
import { executeAction } from "../src/monkey/executor.ts";
import { runMonkey, type StepRecord } from "../src/monkey/loop.ts";
import { IgnoreRules } from "../src/oracles/finding.ts";
import { firstStackFrame, normalizeMessage, normalizeUrl } from "../src/oracles/keys.ts";
import { Oracles } from "../src/oracles/oracles.ts";
import { snapshot } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

const ORIGIN = "https://test.example.org";

describe("dedup keys", () => {
  it("normalizes ids and numbers in URL paths and drops query and fragment", () => {
    assert.equal(normalizeUrl(`${ORIGIN}/orders/123/items/9?page=2#top`, ORIGIN), "/orders/:n/items/:n");
    assert.equal(normalizeUrl(`${ORIGIN}/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301/edit`, ORIGIN), "/u/:id/edit");
    assert.equal(normalizeUrl(`${ORIGIN}/assets/app.js`, ORIGIN), "/assets/app.js");
    assert.equal(normalizeUrl(`${ORIGIN}/c/5f8d0d55b54764421b7156c3`, ORIGIN), "/c/:id");
    assert.equal(normalizeUrl(`${ORIGIN}/s/aB3dE5fG7hJ9kL1mN`, ORIGIN), "/s/:id");
    assert.equal(normalizeUrl(`${ORIGIN}/v2/about-us`, ORIGIN), "/v2/about-us");
  });

  it("keeps foreign origins but drops the site's own, so keys survive a port change", () => {
    assert.equal(normalizeUrl("https://cdn.example.net/lib/1/x.js", ORIGIN), "https://cdn.example.net/lib/:n/x.js");
    assert.equal(
      normalizeUrl("http://127.0.0.1:41234/form", "http://127.0.0.1:41234"),
      normalizeUrl("http://127.0.0.1:50000/form", "http://127.0.0.1:50000"),
    );
    assert.equal(normalizeUrl("not a url"), "not a url");
  });

  it("normalizes messages: numbers, ids, URLs and whitespace", () => {
    assert.equal(
      normalizeMessage("Order 4711 failed  after 3 retries", ORIGIN),
      normalizeMessage("Order 815 failed after 12 retries", ORIGIN),
    );
    assert.equal(normalizeMessage("id deadbeef01 missing"), "id :id missing");
    assert.equal(
      normalizeMessage(`GET ${ORIGIN}/api/users/42?x=1 failed with 500`, ORIGIN),
      "GET /api/users/:n failed with #",
    );
    assert.equal(normalizeMessage("x".repeat(400)).length, 300);
  });

  it("takes the first stack frame with line and column, URL normalized", () => {
    const v8 = `Error: boom\n    at HTMLButtonElement.<anonymous> (${ORIGIN}/js-error?v=3:23:11)\n    at other (x:1:1)`;
    assert.equal(firstStackFrame(v8, ORIGIN), "at HTMLButtonElement.<anonymous> (/js-error:23:11)");
    const firefox = `@${ORIGIN}/static/app.js:10:5\nouter@${ORIGIN}/static/app.js:2:1`;
    assert.equal(firstStackFrame(firefox, ORIGIN), "@/static/app.js:10:5");
    assert.equal(firstStackFrame("Error: no frames"), "");
    assert.equal(firstStackFrame(undefined), "");
  });
});

describe("IgnoreRules", () => {
  const rules = new IgnoreRules([
    { oracle: "console", message: "^Third party" },
    { url: "analytics\\.example" },
    { oracle: "http4xx", url: "/favicon", message: "404" },
  ]);
  const signal = (oracle: "console" | "http4xx" | "pageerror", url: string, message: string) => ({
    oracle,
    url,
    message,
  });

  it("matches a rule only when every part it sets matches", () => {
    assert.equal(rules.matches(signal("console", ORIGIN, "Third party widget failed")), true);
    assert.equal(rules.matches(signal("pageerror", ORIGIN, "Third party widget failed")), false);
    assert.equal(rules.matches(signal("pageerror", "https://analytics.example/t.js", "boom")), true);
    assert.equal(rules.matches(signal("http4xx", `${ORIGIN}/favicon.ico`, "GET /favicon.ico responded 404")), true);
    assert.equal(rules.matches(signal("http4xx", `${ORIGIN}/favicon.ico`, "GET /favicon.ico responded 403")), false);
  });

  it("matches nothing without rules", () => {
    assert.equal(new IgnoreRules([]).matches(signal("console", ORIGIN, "x")), false);
  });
});

describe("oracles in the browser", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-oracles-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  function config(extra: Record<string, unknown> = {}): Config {
    return parseConfig(JSON.stringify({ baseUrl: site.url, seed: 1, monkey: { actionTimeoutMs: 1000 }, ...extra }), {
      env: {},
    }).config;
  }

  /** A context with oracles attached and a page on `path`; `check` files what happened since the last check. */
  async function watch(path: string, extra: Record<string, unknown> = {}) {
    const context = await browser.newContext({ baseURL: site.url, viewport: { width: 1280, height: 800 } });
    const oracles = new Oracles(context, {
      config: config(extra),
      role: "tester",
      screenshotDir: join(dir, `shots-${Math.random().toString(36).slice(2)}`),
    });
    const page = await context.newPage();
    await page.goto(path);
    let step = 0;
    const check = async (navigated = true) => {
      step++;
      await oracles.check(record(step, page, navigated), page);
      return oracles.findings;
    };
    return { context, oracles, page, check };
  }

  async function withWatch<T>(
    path: string,
    extra: Record<string, unknown>,
    run: (w: Awaited<ReturnType<typeof watch>>) => Promise<T>,
  ): Promise<T> {
    const w = await watch(path, extra);
    try {
      return await run(w);
    } finally {
      await w.context.close();
    }
  }

  it("stays silent on the control pages and on a valid form submission", async () => {
    await withWatch("/clean", {}, async ({ page, check }) => {
      await page.getByLabel("Search").fill("<script>alert(1)</script>");
      await page.getByRole("button", { name: "Show details" }).click();
      await check(false);
      await page.goto("/login");
      await page.getByLabel("Username").fill("wrong");
      await page.getByRole("button", { name: "Log in" }).click();
      await check();
      await page.goto("/form");
      await page.getByLabel("Name").fill("Monkey");
      await page.getByLabel("Email").fill("monkey@test.local");
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForURL("**/form");
      assert.deepEqual(await check(), []);
    });
  });

  it("reports a broken link as one http4xx finding, without console or errorPage duplicates", async () => {
    await withWatch("/", {}, async ({ page, check }) => {
      await page.getByRole("link", { name: "Broken link" }).click();
      const [finding, ...rest] = await check();
      assert.deepEqual(rest, []);
      assert.equal(finding?.oracle, "http4xx");
      assert.equal(finding?.severity, "medium");
      assert.equal(finding?.message, "GET /missing-page responded 404 Not Found");
      assert.deepEqual(finding?.details, {
        method: "GET",
        url: `${site.url}/missing-page`,
        status: 404,
        statusText: "Not Found",
        resourceType: "document",
      });
    });
  });

  it("counts repeats as occurrences of the first finding and keeps its context", async () => {
    await withWatch("/js-error", {}, async ({ page, check }) => {
      const button = page.getByRole("button", { name: "Do not press" });
      await button.click();
      const [first] = await check(false);
      await button.click();
      await button.click();
      const findings = await check(false);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.occurrences, 3);
      assert.equal(findings[0]?.step, 1);
      assert.equal(findings[0]?.lastActions.length, 1);
      assert.equal(first?.oracle, "pageerror");
      assert.match(String(first?.details.stack), /Seeded bug: click handler crashed/);
    });
  });

  it("deduplicates HTTP errors whose URLs differ only in ids", async () => {
    await withWatch("/clean", {}, async ({ page, check }) => {
      await page.evaluate(async () => {
        await fetch("/items/1");
        await fetch("/items/2?full=1");
      });
      const findings = await check(false);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.key, "http4xx|GET /items/:n 404");
      assert.equal(findings[0]?.severity, "low");
      assert.equal(findings[0]?.occurrences, 2);
    });
  });

  it("reports the HTTP 500 of the form and the console error", async () => {
    await withWatch("/console-error", {}, async ({ page, check }) => {
      await page.goto("/form");
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForURL("**/form");
      const findings = await check();
      assert.deepEqual(
        findings.map((f) => `${f.oracle} ${f.severity} ${f.message}`),
        [
          "console medium Seeded bug: console error on load",
          "http5xx high POST /form responded 500 Internal Server Error",
        ],
      );
    });
  });

  it("counts an overflow once per visit, not once per step", async () => {
    await withWatch("/overflow", {}, async ({ page, check }) => {
      await check();
      await check(false);
      await page.setViewportSize({ width: 390, height: 844 });
      const [finding, ...rest] = await check(false);
      assert.deepEqual(rest, []);
      assert.equal(finding?.occurrences, 1);
      assert.equal(finding?.key, "overflow|/overflow|div");
      await page.reload();
      assert.equal((await check())[0]?.occurrences, 2);
    });
  });

  it("applies ignoreStatus and ignore rules", async () => {
    const run = async (findings: Record<string, unknown>) =>
      withWatch("/missing-page", { findings }, async ({ page, check }) => {
        await page.goto("/console-error");
        return (await check()).map((f) => f.oracle);
      });
    assert.deepEqual(await run({}), ["http4xx", "console"]);
    assert.deepEqual(await run({ ignoreStatus: [404] }), ["console"]);
    assert.deepEqual(await run({ ignore: [{ url: "missing" }, { oracle: "console", message: "^Seeded" }] }), []);
  });

  it("switches oracles off", async () => {
    await withWatch("/console-error", { oracles: { console: false, overflow: false } }, async ({ page, check }) => {
      await page.goto("/overflow");
      assert.deepEqual(await check(), []);
    });
  });

  it("reports error pages: a soft 404, and a failed status when the HTTP oracle is off", async () => {
    await withWatch("/clean", {}, async ({ context, page, check }) => {
      await context.route("**/gone", (route) =>
        route.fulfill({ contentType: "text/html", body: "<title>Page not found</title><h1>Oops</h1>" }),
      );
      await page.goto("/gone");
      const [finding] = await check();
      assert.equal(finding?.oracle, "errorPage");
      assert.equal(finding?.message, "error page on /gone (status 200): Page not found");
    });
    await withWatch("/missing-page", { oracles: { http4xx: false } }, async ({ check }) => {
      const findings = await check();
      assert.deepEqual(
        findings.map((f) => f.message),
        ["error page on /missing-page (status 404): Not found"],
      );
    });
  });

  it("reports a navigation that never loads and a page that stops responding as hangs", async () => {
    await withWatch("/clean", {}, async ({ context, oracles, page }) => {
      await context.route("**/never", () => {
        // Never answered.
      });
      const result = await executeAction({ context, current: 0 }, { type: "navigate", url: `${site.url}/never` }, 300);
      assert.equal(result.hang, true);
      await oracles.check({ ...record(1, page, false), result }, page);
      await page.goto("/clean");
      await page.evaluate("setTimeout(() => { for (;;) {} }, 0)");
      await oracles.check(record(2, page, false), page);
      assert.deepEqual(
        oracles.findings.map((f) => `${f.oracle} ${f.severity} ${f.details.kind}`),
        ["hang high navigation", "hang high unresponsive"],
      );
      assert.equal(oracles.findings[1]?.screenshotPath, undefined);
    });
  });

  it("does not report an element that never becomes clickable as a hang", async () => {
    await withWatch("/clean", {}, async ({ context, oracles, page }) => {
      await page.setContent('<button>Covered</button><div style="position:fixed;inset:0;background:#fff8"></div>');
      const button = (await snapshot(page)).elements.find((element) => element.name === "Covered");
      assert.ok(button !== undefined);
      const result = await executeAction({ context, current: 0 }, { type: "click", ref: button.ref }, 300);
      assert.equal(result.ok, false);
      assert.equal(result.hang, undefined);
      await oracles.check({ ...record(1, page, false), result }, page);
      assert.deepEqual(oracles.findings, []);
    });
  });

  it("reports a crashed page as critical and the monkey carries on in a new page", async () => {
    const context = await browser.newContext({ baseURL: site.url });
    try {
      const cfg = config({ limits: { maxSteps: 4 }, oracles: { console: false, http4xx: false, overflow: false } });
      const oracles = new Oracles(context, { config: cfg, role: "tester", screenshotDir: join(dir, "crash") });
      const result = await runMonkey(context, {
        config: cfg,
        onStep: async (rec: StepRecord) => {
          const page = context.pages()[rec.result.tab] ?? context.pages()[0];
          if (rec.step === 2 && page !== undefined) {
            // The crash event can arrive after goto settles (headless shell), so wait for it explicitly.
            await Promise.all([page.waitForEvent("crash"), page.goto("chrome://crash").catch(() => undefined)]);
          }
          await oracles.check(rec, page);
        },
      });
      assert.equal(result.stopReason, "maxSteps");
      assert.equal(result.steps, 4);
      const crash = (await oracles.finish()).filter((f) => f.oracle === "crash");
      assert.equal(crash.length, 1);
      assert.equal(crash[0]?.severity, "critical");
      assert.equal(crash[0]?.step, 2);
    } finally {
      await context.close();
    }
  });

  it("keeps the configured number of last actions", async () => {
    await withWatch("/clean", { findings: { lastActions: 2 } }, async ({ page, check }) => {
      await check(false);
      await check(false);
      await page.goto("/console-error");
      const [finding] = await check();
      assert.deepEqual(
        finding?.lastActions.map((a) => a.step),
        [2, 3],
      );
    });
  });
});

function record(step: number, page: Page, navigated: boolean): StepRecord {
  return {
    step,
    action: { type: "scroll", deltaY: 100 },
    url: page.url(),
    snapshotHash: "h",
    source: "monkey",
    result: { ok: true, navigated, url: page.url(), tab: 0 },
  };
}
