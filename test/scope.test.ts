import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { ConfigError, parseConfig } from "../src/config/config.ts";
import { ACTION_TYPES, type ActionType } from "../src/config/values.ts";
import { chooseAction, Exploration } from "../src/monkey/chooser.ts";
import type { PlannedAction, StepRecord } from "../src/monkey/loop.ts";
import { Random } from "../src/monkey/random.ts";
import { UrlScope } from "../src/monkey/scope.ts";
import { runRole } from "../src/run.ts";
import type { Snapshot, SnapshotElement } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

const BASE = "https://test.example.org";

function issuesOf(config: unknown): string[] {
  try {
    parseConfig(JSON.stringify(config), { env: {} });
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
  return [];
}

describe("UrlScope", () => {
  it("allows everything without patterns", () => {
    const scope = new UrlScope({ allow: [], deny: [] });
    assert.equal(scope.restricted, false);
    assert.equal(scope.allows(`${BASE}/admin`), true);
  });

  it("needs a match in allow and none in deny", () => {
    const scope = new UrlScope({ allow: ["/shop(/|$)"], deny: ["/shop/admin"] });
    assert.equal(scope.restricted, true);
    assert.equal(scope.allows(`${BASE}/shop`), true);
    assert.equal(scope.allows(`${BASE}/shop/cart`), true);
    assert.equal(scope.allows(`${BASE}/shop/admin/delete`), false);
    assert.equal(scope.allows(`${BASE}/blog`), false);
  });

  it("resolves links against the page and lets non-http links through", () => {
    const scope = new UrlScope({ allow: [], deny: ["/logout"] });
    assert.equal(scope.allowsLink("/logout", `${BASE}/account`), false);
    assert.equal(scope.allowsLink("settings", `${BASE}/account/`), true);
    assert.equal(scope.allowsLink("javascript:void(0)", `${BASE}/`), true);
    assert.equal(scope.allowsLink("http://[bad", `${BASE}/`), true);
  });
});

describe("scope in the config", () => {
  it("rejects invalid patterns and a baseUrl outside the scope", () => {
    assert.deepEqual(issuesOf({ baseUrl: BASE, scope: { allow: ["("], deny: ["ok", "["] } }), [
      "scope.allow[0]: is not a valid regular expression",
      "scope.deny[1]: is not a valid regular expression",
    ]);
    assert.deepEqual(issuesOf({ baseUrl: `${BASE}/`, scope: { allow: ["/shop"], deny: ["example"] } }), [
      "scope.allow: does not allow baseUrl, where every run starts",
      "scope.deny: denies baseUrl, where every run starts",
    ]);
    assert.deepEqual(issuesOf({ baseUrl: `${BASE}/shop`, scope: { allow: ["/shop"] } }), []);
  });
});

describe("chooseAction with a scope", () => {
  const element = (ref: string, url: string): SnapshotElement => ({
    ref,
    role: "link",
    name: ref,
    url,
    enabled: true,
    inViewport: true,
    inFrame: false,
  });
  const snap: Snapshot = {
    url: `${BASE}/`,
    title: "t",
    elements: [element("e1", "/admin/delete-all"), element("e2", "/shop")],
    text: "",
    crossOriginFrames: 0,
    dialogs: [],
    hash: "h",
  };
  const weights = Object.fromEntries(ACTION_TYPES.map((t) => [t, t === "click" ? 1 : 0])) as Record<ActionType, number>;

  it("never clicks a link outside the scope", () => {
    const random = new Random(5);
    const scope = new UrlScope({ allow: [], deny: ["/admin/"] });
    for (let i = 0; i < 200; i++) {
      const { action } = chooseAction(snap, new Exploration(), random, {
        weights,
        testData: {},
        scope,
        tabCount: 1,
        currentTab: 0,
        viewport: { width: 1280, height: 800 },
      });
      assert.deepEqual(action, { type: "click", ref: "e2" });
    }
  });
});

describe("scope in a run against the fixture site", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-scope-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  async function drive(name: string, deny: string[], actions: PlannedAction[]) {
    const loaded = parseConfig(
      JSON.stringify({ baseUrl: site.url, seed: 1, scope: { deny }, monkey: { actionTimeoutMs: 2000 } }),
    );
    const records: StepRecord[] = [];
    const outcome = await runRole(browser, undefined, loaded, {
      log: () => {},
      outputDir: join(dir, name),
      actionLog: false,
      replay: { strict: true, actions },
      onStep: (record) => {
        records.push(record);
      },
    });
    return { outcome, records };
  }

  const step = (action: PlannedAction["action"], locator?: string): PlannedAction => ({
    action,
    source: "monkey",
    ...(locator === undefined ? {} : { locator }),
  });

  it("blocks clicks and navigations to denied pages, so their bugs are never found", async () => {
    const { outcome, records } = await drive(
      "blocked",
      ["/js-error"],
      [
        step({ type: "click", ref: "x" }, "getByRole('link', { name: 'JS error' })"),
        step({ type: "navigate", url: `${site.url}/js-error` }),
        step({ type: "scroll", deltaY: 300 }),
      ],
    );
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? "no error");
    assert.equal(outcome.blockedNavigations, 2);
    assert.ok(records.every((record) => new URL(record.url).pathname === "/"));
    assert.deepEqual(outcome.findings, []);
  });

  it("brings the page back when a redirect lands outside the scope", async () => {
    // /account redirects to /login without a session; the guard sees only the first request.
    const { outcome, records } = await drive(
      "redirect",
      ["/login"],
      [step({ type: "navigate", url: `${site.url}/account` }), step({ type: "scroll", deltaY: 300 })],
    );
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? "no error");
    assert.equal(records[1]?.url, `${site.url}/`);
  });
});
