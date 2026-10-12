import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { type Config, parseConfig } from "../src/config/config.ts";
import { ACTION_TYPES, type ActionType } from "../src/config/schema.ts";
import { describeAction } from "../src/monkey/actions.ts";
import { chooseAction, Exploration } from "../src/monkey/chooser.ts";
import { executeAction } from "../src/monkey/executor.ts";
import { runMonkey, type StepRecord } from "../src/monkey/loop.ts";
import { Random } from "../src/monkey/random.ts";
import { chooseFillValue, matchingTestData, NASTY_VALUES } from "../src/monkey/values.ts";
import type { Snapshot, SnapshotElement } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

describe("Random", () => {
  it("is deterministic per seed and platform independent", () => {
    const a = new Random(42);
    const b = new Random(42);
    const first = Array.from({ length: 5 }, () => a.next());
    assert.deepEqual(
      first,
      Array.from({ length: 5 }, () => b.next()),
    );
    // Pinned values: a change here changes every recorded run.
    assert.deepEqual(
      [0, 1, 42, 4294967295].map((seed) => new Random(seed).int(1_000_000)),
      [979145, 425649, 239553, 329163],
    );
    assert.ok(first.every((value) => value >= 0 && value < 1));
  });

  it("differs between seeds", () => {
    const sequence = (seed: number) =>
      Array.from(
        { length: 10 },
        (
          (r) => () =>
            r.int(1000)
        )(new Random(seed)),
      );
    assert.notDeepEqual(sequence(1), sequence(2));
  });

  it("never picks an item with weight 0 and roughly follows the weights", () => {
    const random = new Random(7);
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 10_000; i++)
      counts[random.weighted(["a", "b", "c"] as const, (x) => ({ a: 1, b: 3, c: 0 })[x])]++;
    assert.equal(counts.c, 0);
    assert.ok(counts.b > counts.a * 2.5 && counts.b < counts.a * 3.5, JSON.stringify(counts));
  });
});

describe("fill values", () => {
  const field = (name: string, placeholder?: string): SnapshotElement => ({
    ref: "e1",
    role: "textbox",
    name,
    ...(placeholder === undefined ? {} : { placeholder }),
    enabled: true,
    inViewport: true,
    inFrame: false,
  });

  it("matches test data by name or placeholder", () => {
    const data = { email: "monkey@test.local", iban: "DE89370400440532013000", phone: "+49 30 1234567" };
    assert.deepEqual(matchingTestData(field("E-Mail address"), data), ["monkey@test.local"]);
    assert.deepEqual(matchingTestData(field("Account", "IBAN"), data), ["DE89370400440532013000"]);
    assert.deepEqual(matchingTestData(field("Comment"), data), []);
  });

  it("mixes valid and nasty values deterministically", () => {
    const pick = (seed: number) => {
      const random = new Random(seed);
      return Array.from({ length: 200 }, () => chooseFillValue(field("Email"), { email: "monkey@test.local" }, random));
    };
    const values = pick(3);
    assert.deepEqual(values, pick(3));
    assert.ok(values.includes("monkey@test.local"));
    assert.ok(values.some((value) => NASTY_VALUES.includes(value) && value !== "monkey@test.local"));
    assert.ok(values.includes("x".repeat(10_000)));
  });
});

describe("chooseAction", () => {
  const element = (ref: string, role: string, name: string, extra: Partial<SnapshotElement> = {}): SnapshotElement => ({
    ref,
    role,
    name,
    enabled: true,
    inViewport: true,
    inFrame: false,
    ...extra,
  });
  const page = (elements: SnapshotElement[]): Snapshot => ({
    url: "https://test.example.org/",
    title: "t",
    elements,
    text: "",
    crossOriginFrames: 0,
    dialogs: [],
    hash: "h",
  });
  const only = (type: ActionType) =>
    Object.fromEntries(ACTION_TYPES.map((t) => [t, t === type ? 1 : 0])) as Record<ActionType, number>;
  const options = (weights: Record<ActionType, number>) => ({
    weights,
    testData: {},
    origin: "https://test.example.org",
    tabCount: 1,
    currentTab: 0,
    viewport: { width: 1280, height: 800 },
  });

  it("never clicks links to other origins with stayOnDomain, nor disabled elements", () => {
    const snap = page([
      element("e1", "link", "Out", { url: "https://elsewhere.example/" }),
      element("e2", "button", "Off", { enabled: false }),
      element("e3", "link", "In", { url: "/in" }),
    ]);
    const random = new Random(1);
    for (let i = 0; i < 200; i++) {
      const { action } = chooseAction(snap, new Exploration(), random, options(only("click")));
      assert.deepEqual(action, { type: "click", ref: "e3" });
    }
  });

  it("maps roles to actions and toggles checked boxes off", () => {
    const random = new Random(2);
    const choose = (el: SnapshotElement, type: ActionType) =>
      chooseAction(page([el]), new Exploration(), random, options(only(type))).action;
    assert.deepEqual(choose(element("e1", "checkbox", "A", { checked: true }), "check"), {
      type: "uncheck",
      ref: "e1",
    });
    assert.deepEqual(choose(element("e1", "checkbox", "A", { checked: false }), "check"), { type: "check", ref: "e1" });
    assert.deepEqual(choose(element("e1", "combobox", "Topic", { options: ["Only"] }), "select"), {
      type: "select",
      ref: "e1",
      value: "Only",
    });
    assert.equal(choose(element("e1", "textbox", "Name"), "fill").type, "fill");
  });

  it("prefers elements it has not used in this state", () => {
    const snap = page([element("e1", "button", "Used"), element("e2", "button", "Fresh")]);
    const exploration = new Exploration();
    for (let i = 0; i < 20; i++) exploration.recordAction("https://test.example.org/#h", "button\u0000Used\u00000");
    const random = new Random(3);
    let fresh = 0;
    for (let i = 0; i < 1000; i++) {
      const { action } = chooseAction(snap, exploration, random, options(only("click")));
      if (action.type === "click" && action.ref === "e2") fresh++;
    }
    assert.ok(fresh > 900, `fresh chosen ${fresh} times`);
  });

  it("falls back to global actions when a page has no elements", () => {
    const { action } = chooseAction(page([]), new Exploration(), new Random(4), options(only("click")));
    assert.equal(action.type, "scroll");
  });
});

describe("the monkey against the fixture site", () => {
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

  function config(extra: Record<string, unknown>): Config {
    return parseConfig(
      JSON.stringify({ baseUrl: site.url, testData: { email: "monkey@test.local", name: "Monkey" }, ...extra }),
      { env: {} },
    ).config;
  }

  async function withContext<T>(run: (context: BrowserContext) => Promise<T>): Promise<T> {
    const context = await browser.newContext({ baseURL: site.url, viewport: { width: 1280, height: 800 } });
    try {
      return await run(context);
    } finally {
      await context.close();
    }
  }

  async function record(seed: number, maxSteps: number): Promise<string[]> {
    return withContext(async (context) => {
      const steps: string[] = [];
      const result = await runMonkey(context, {
        config: config({ seed, limits: { maxSteps } }),
        onStep: (rec) => {
          steps.push(`${describeAction(rec.action)} ${rec.locator ?? ""} @${new URL(rec.url).pathname}`);
        },
      });
      assert.equal(result.stopReason, "maxSteps");
      assert.equal(result.steps, maxSteps);
      return steps;
    });
  }

  it("repeats the same action sequence for the same seed", async () => {
    const first = await record(11, 60);
    const second = await record(11, 60);
    assert.deepEqual(second, first);
  });

  it("produces a different sequence for a different seed", async () => {
    assert.notDeepEqual(await record(12, 30), await record(13, 30));
  });

  // N = 3 seeds; each reaches all pages and triggers all seeded bugs well within the default 500 steps.
  for (const seed of [1, 2, 3]) {
    it(`reaches every page and triggers every seeded bug within 500 steps (seed ${seed})`, async () => {
      await withContext(async (context) => {
        const signals = new Set<string>();
        const pages = new Set<string>();
        context.on("page", (p) => {
          p.on("pageerror", () => signals.add("pageerror"));
          p.on("console", (m) => {
            if (m.text().startsWith("Seeded bug")) signals.add("console");
          });
          p.on("response", (r) => {
            if (r.status() >= 400) signals.add(`${r.status()} ${new URL(r.url()).pathname}`);
          });
        });
        const goals = ["pageerror", "console", "404 /missing-page", "500 /form", "overflow"];
        const allPages = [
          "/",
          "/login",
          "/form",
          "/js-error",
          "/console-error",
          "/overflow",
          "/clean",
          "/missing-page",
        ];
        const abort = new AbortController();
        const result = await runMonkey(context, {
          config: config({ seed }),
          signal: abort.signal,
          onStep: (rec: StepRecord) => {
            const path = new URL(rec.result.url).pathname;
            pages.add(path);
            if (path === "/overflow") signals.add("overflow");
            if (goals.every((goal) => signals.has(goal)) && allPages.every((p) => pages.has(p))) abort.abort();
          },
        });
        assert.equal(
          result.stopReason,
          "aborted",
          `missing: ${goals.filter((g) => !signals.has(g))} pages ${[...pages]}`,
        );
        assert.ok(result.steps <= 500);
      });
    });
  }

  it("records failed actions and keeps going", async () => {
    await withContext(async (context) => {
      await context.route(`${site.url}/covered`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<button>Covered</button><div style="position:fixed;inset:0;background:#fff8"></div>',
        }),
      );
      const page = await context.newPage();
      await page.goto(`${site.url}/covered`);
      const weights = Object.fromEntries(ACTION_TYPES.map((t) => [t, t === "click" ? 1 : 0]));
      const failures: string[] = [];
      const result = await runMonkey(context, {
        config: config({ seed: 5, limits: { maxSteps: 3 }, monkey: { actionTimeoutMs: 200, weights } }),
        onStep: (rec) => {
          if (!rec.result.ok) failures.push(rec.result.error ?? "");
        },
      });
      assert.equal(result.stopReason, "maxSteps");
      assert.equal(result.failedActions, 3);
      assert.equal(failures.length, 3);
    });
  });

  it("goes on in another tab when the page closes while it is being read", async () => {
    await withContext(async (context) => {
      const first = await context.newPage();
      await first.goto(site.url);
      const other = await context.newPage();
      await other.goto(site.url);
      // Like a popup that calls window.close() at the wrong moment: closes during the second snapshot.
      let reads = 0;
      const read = first.ariaSnapshotJSON.bind(first);
      first.ariaSnapshotJSON = (async (options: Parameters<typeof read>[0]) => {
        if (++reads === 2) await first.close();
        return read(options);
      }) as typeof read;
      const weights = Object.fromEntries(ACTION_TYPES.map((t) => [t, t === "scroll" ? 1 : 0]));
      const result = await runMonkey(context, {
        config: config({ seed: 7, limits: { maxSteps: 4 }, monkey: { weights } }),
      });
      assert.equal(reads, 2);
      assert.equal(result.stopReason, "maxSteps", result.error);
      assert.equal(result.steps, 4);
    });
  });

  it("returns a failed result for a stale ref instead of throwing", async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(site.url);
      const result = await executeAction({ context, current: 0 }, { type: "click", ref: "e999" }, 1000);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /e999 is gone/);
    });
  });

  it("stops at maxMinutes", async () => {
    await withContext(async (context) => {
      let clock = 0;
      const result = await runMonkey(context, {
        config: config({ seed: 6, limits: { maxMinutes: 1 } }),
        now: () => {
          clock += 20_000;
          return clock;
        },
      });
      assert.equal(result.stopReason, "maxMinutes");
      assert.ok(result.steps < 5);
    });
  });
});
