import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { parseConfig } from "../src/config/config.ts";
import type { PlannedAction } from "../src/monkey/loop.ts";
import { AccessibilityAudit } from "../src/oracles/accessibility.ts";
import { runRole } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";

describe("the accessibility oracle against the fixture site", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-a11y-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  const step = (action: PlannedAction["action"], locator?: string): PlannedAction => ({
    action,
    source: "monkey",
    ...(locator === undefined ? {} : { locator }),
  });

  async function drive(name: string, oracles: Record<string, boolean>) {
    const loaded = parseConfig(JSON.stringify({ baseUrl: `${site.url}/lab/gallery`, seed: 1, oracles }));
    const outcome = await runRole(browser, undefined, loaded, {
      log: () => {},
      outputDir: join(dir, name),
      actionLog: false,
      replay: {
        strict: true,
        actions: [
          step({ type: "scroll", deltaY: 300 }),
          step({ type: "click", ref: "x" }, "getByRole('link', { name: 'Next page' })"),
          step({ type: "navigate", url: `${site.url}/lab/news` }),
          step({ type: "navigate", url: `${site.url}/clean` }),
          step({ type: "navigate", url: `${site.url}/lab/gallery` }),
        ],
      },
    });
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? "no error");
    return outcome;
  }

  it("reports the image without alt text once, however often its page is visited, and nothing on clean pages", async () => {
    const { findings } = await drive("on", { accessibility: true });
    assert.deepEqual(
      findings.map((f) => [f.oracle, f.severity, f.key, f.step, f.occurrences]),
      [["accessibility", "medium", "accessibility|image-alt|/lab/gallery", 1, 1]],
    );
    assert.match(findings[0]?.message ?? "", /^image-alt on \/lab\/gallery: .* \(1 element\)$/);
    const details = findings[0]?.details as { targets: string[] } | undefined;
    assert.match(details?.targets.join() ?? "", /^img:nth-child\(\d+\)$/);
  });

  it("is off by default", async () => {
    assert.deepEqual((await drive("off", {})).findings, []);
  });

  it("tries again when an audit fails or takes too long", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${site.url}/lab/gallery`);
      const audit = new AccessibilityAudit(site.url);
      assert.deepEqual(await audit.audit(page, 1), []);
      assert.equal((await audit.audit(page, 10_000)).length, 1);
      assert.deepEqual(await audit.audit(page, 10_000), [], "audited once per page");
      await page.close();
      assert.deepEqual(await new AccessibilityAudit(site.url).audit(page, 10_000), []);
    } finally {
      await page.close();
    }
  });
});
