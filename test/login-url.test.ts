import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { openRoleSession } from "../src/auth/session.ts";
import { parseConfig } from "../src/config/config.ts";
import { launchChromium } from "./helpers/browser.ts";

describe("auth[].loginUrl under a baseUrl with a path", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-login-url-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** The session cookies after logging in: `shop_sid` from the demo shop's login, `sid` from the main site's. */
  async function cookiesAfterLogin(baseUrl: string, loginUrl: string): Promise<string[]> {
    const { config, secrets } = parseConfig(
      JSON.stringify({
        baseUrl,
        auth: [{ name: "user", loginUrl, fields: { ...FIXTURE_CREDENTIALS }, submit: "button[type=submit]" }],
      }),
    );
    const session = await openRoleSession(browser, config.auth[0], {
      config,
      secrets,
      outputDir: await mkdtemp(join(dir, "run-")),
      trace: false,
      video: false,
      loginTimeoutMs: 5000,
    });
    try {
      return (await session.context.cookies()).map((cookie) => cookie.name).sort();
    } finally {
      await session.close();
    }
  }

  it("resolves loginUrl against baseUrl like a link", async () => {
    // A leading slash is relative to the origin, so the path prefix is written out.
    assert.deepEqual(await cookiesAfterLogin(`${site.url}/demo`, "/demo/login"), ["shop_sid"]);
    // Without one, the last segment of baseUrl is replaced, unless baseUrl ends with a slash.
    assert.deepEqual(await cookiesAfterLogin(`${site.url}/demo/`, "login"), ["shop_sid"]);
    assert.deepEqual(await cookiesAfterLogin(`${site.url}/demo`, "login"), ["sid"]);
  });
});
