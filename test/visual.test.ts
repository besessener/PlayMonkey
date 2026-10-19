import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { type LlmConfig, parseConfig } from "../src/config/config.ts";
import { LlmError } from "../src/llm/provider.ts";
import { maskedScreenshot } from "../src/llm/screenshot.ts";
import { LlmStats } from "../src/llm/usage.ts";
import { runRole } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";

const SECRET = "s3cr3t-Pa55";
const HIDDEN = "[data-monkey-hide]";

describe("screenshots for the LLM", () => {
  let browser: Browser;
  before(async () => {
    browser = await launchChromium();
  });
  after(() => browser?.close());

  it("hides every secret on the page, in fields, frames and shadow roots, and cleans up after itself", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <input type="password" value="anything">
        <input value="before ${SECRET} after">
        <input placeholder="${SECRET}">
        <div>Hello ${SECRET}</div>
        <p>${SECRET.slice(0, 4)}<b>${SECRET.slice(4, 9)}</b>${SECRET.slice(9)}</p>
        <select><option selected>${SECRET}</option></select>
        <div id="host"></div>
        <iframe srcdoc="<p>${SECRET}</p>"></iframe>
        <p>Nothing to hide here.</p>`);
      await page.evaluate(
        `document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<span>${SECRET}</span>"`,
      );
      const capture = await maskedScreenshot(page, { secrets: [SECRET], timeoutMs: 5000 });
      assert.ok(capture.ok, capture.ok ? "" : capture.reason);
      // Password, value, placeholder, text, split text, select and its option, shadow root, frame.
      assert.equal(capture.hidden, 9);
      assert.equal(capture.screenshot.mediaType, "image/jpeg");
      assert.ok(capture.screenshot.data.startsWith("/9j/"), "a JPEG");
      for (const frame of page.frames()) assert.equal(await frame.locator(HIDDEN).count(), 0);
      assert.equal(await page.locator(`#host ${HIDDEN}`).count(), 0);

      // Password fields are hidden without any configured secret too.
      const plain = await maskedScreenshot(page, { secrets: [], timeoutMs: 5000 });
      assert.equal(plain.ok && plain.hidden, 1);
    } finally {
      await page.close();
    }
  });

  it("sends no screenshot when the page cannot be checked for secrets in time", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<p>Busy</p>");
      await page.evaluate("setTimeout(() => { for (;;) {} }, 0)");
      const capture = await maskedScreenshot(page, { secrets: [SECRET], timeoutMs: 300 });
      assert.deepEqual(capture, { ok: false, reason: "a frame could not be checked for secrets in time" });
    } finally {
      await page.close({ runBeforeUnload: false });
    }
    const closed = await maskedScreenshot(page, { secrets: [], timeoutMs: 300 });
    assert.deepEqual(closed, { ok: false, reason: "the page is closed" });
  });
});

describe("the visual oracle against the fixture site", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-visual-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** A run of the random monkey on the two visual pages, with only the visual oracle on and an LLM that never acts. */
  async function run(name: string, provider: FakeProvider, extra: { oracles?: object; llm?: object } = {}) {
    const loaded = parseConfig(
      JSON.stringify({
        baseUrl: `${site.url}/lab/visual`,
        seed: 3,
        limits: { maxSteps: 12 },
        scope: { allow: ["/lab/visual"] },
        oracles: { pageerror: false, console: false, http4xx: false, overflow: false, visual: true, ...extra.oracles },
        llm: {
          provider: "openai",
          baseUrl: "https://res.openai.azure.com/openai/v1",
          deployment: "model",
          apiKey: "${KEY}",
          handoff: { noProgress: 9999, noStateChange: 9999, failedActions: 9999, blockingUi: false },
          ...extra.llm,
        },
      }),
      { env: { KEY: "key-0123456789" } },
    );
    const stats = new LlmStats(loaded.config.llm as LlmConfig, provider.name);
    const lines: string[] = [];
    const outcome = await runRole(browser, undefined, loaded, {
      log: (line) => lines.push(line),
      outputDir: join(dir, name),
      actionLog: false,
      artifacts: false,
      llm: { provider, stats },
    });
    return { outcome, stats, lines };
  }

  it("serves a badge covering the button, a fixed layout without, and is linked from neither home nor the lab", async () => {
    const page = await browser.newPage();
    try {
      const covered = async (path: string) => {
        await page.goto(site.url + path);
        const button = await page.getByRole("button", { name: "Pay now" }).boundingBox();
        const badge = await page.getByText("Free shipping over 50 euros").boundingBox();
        assert.ok(button !== null && badge !== null);
        return (
          badge.x < button.x + button.width && button.x < badge.x + badge.width && badge.y < button.y + button.height
        );
      };
      assert.equal(await covered("/lab/visual"), true);
      assert.equal(await covered("/lab/visual/clean"), false);
    } finally {
      await page.close();
    }
    for (const path of ["/", "/lab"]) assert.doesNotMatch(await (await fetch(site.url + path)).text(), /\/lab\/visual/);
  });

  it("reports the covered button exactly once, checks every page once, and nothing on the fixed layout", async () => {
    const provider = new FakeProvider();
    provider.visual = (input) =>
      input.page === "/lab/visual" ? [{ kind: "overlap", description: "The badge covers the Pay now button." }] : [];
    const { outcome, stats } = await run("found", provider);
    assert.equal(outcome.result?.stopReason, "maxSteps", outcome.error ?? "no error");
    const pages = provider.inspections.map((input) => input.page);
    assert.deepEqual([...new Set(pages)], pages, "each page checked once");
    assert.ok(pages.includes("/lab/visual"));
    assert.ok(provider.inspections.every((input) => input.screenshot.data.startsWith("/9j/")));
    assert.deepEqual(
      outcome.findings.map((f) => [f.oracle, f.severity, f.key, f.occurrences]),
      [["visual", "medium", "visual|/lab/visual|overlap", 1]],
    );
    assert.equal(outcome.findings[0]?.message, "overlap on /lab/visual: The badge covers the Pay now button.");
    assert.ok(outcome.findings[0]?.screenshotPath !== undefined);
    assert.equal(stats.report().total.calls, pages.length);
    assert.equal(provider.inputs.length, 0, "no action decisions");
  });

  it("is off by default and never needs the LLM then", async () => {
    const provider = new FakeProvider();
    // `undefined` drops the key from the JSON: the default applies.
    const { outcome } = await run("off", provider, { oracles: { visual: undefined } });
    assert.deepEqual(outcome.findings, []);
    assert.equal(provider.inspections.length, 0);
    assert.throws(
      () => parseConfig(JSON.stringify({ baseUrl: site.url, oracles: { visual: true } })),
      /oracles\.visual: needs an llm section/,
    );
  });

  it("stops checking after llm.breaker.failures failed checks and never fails the run", async () => {
    const provider = new FakeProvider();
    provider.visual = () => new LlmError("server", "500 Internal Server Error");
    const { outcome, stats, lines } = await run("failing", provider, { llm: { breaker: { failures: 1 } } });
    assert.equal(outcome.result?.stopReason, "maxSteps");
    assert.deepEqual(outcome.findings, []);
    assert.equal(provider.inspections.length, 1);
    assert.equal(stats.report().total.errors.server, 1);
    assert.ok(lines.some((line) => /visual checks off for the rest of this run/.test(line)));
  });

  it("respects the shared budget", async () => {
    const provider = new FakeProvider();
    const { stats } = await run("budget", provider, { llm: { maxCalls: 0 } });
    assert.equal(provider.inspections.length, 0);
    assert.match(stats.report().budget.exhausted?.reason ?? "", /llm\.maxCalls \(0\)/);
  });
});
