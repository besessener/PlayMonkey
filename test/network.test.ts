import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { openRoleSession } from "../src/auth/session.ts";
import { parseConfig } from "../src/config/config.ts";
import { ACTION_TYPES, type ActionType } from "../src/config/values.ts";
import { chooseAction, Exploration } from "../src/monkey/chooser.ts";
import type { PlannedAction, StepRecord } from "../src/monkey/loop.ts";
import { Random } from "../src/monkey/random.ts";
import { type ActionLog, readActionLog } from "../src/replay/log.ts";
import { runRole } from "../src/run.ts";
import type { Snapshot } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

const step = (action: PlannedAction["action"], locator?: string): PlannedAction => ({
  action,
  source: "monkey",
  ...(locator === undefined ? {} : { locator }),
});
const loadNews = step({ type: "click", ref: "x" }, "getByRole('button', { name: 'Load news' })");

describe("the offline action in the chooser", () => {
  const snap: Snapshot = {
    url: "https://test.example.org/",
    title: "t",
    elements: [],
    text: "",
    crossOriginFrames: 0,
    dialogs: [],
    hash: "h",
  };
  const weights = (offline: number) => {
    const all = Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])) as Record<ActionType, number>;
    return { ...all, scroll: 1, offline };
  };
  const choose = (offline: number, random: Random) =>
    chooseAction(snap, new Exploration(), random, {
      weights: weights(offline),
      testData: {},
      tabCount: 1,
      currentTab: 0,
      viewport: { width: 1280, height: 800 },
    }).action.type;

  it("is never chosen with its default weight 0, and chosen when weighted", () => {
    const random = new Random(9);
    const types = new Set(Array.from({ length: 200 }, () => choose(0, random)));
    assert.deepEqual([...types], ["scroll"]);
    const weighted = new Set(Array.from({ length: 200 }, () => choose(1, random)));
    assert.ok(weighted.has("offline"));
  });
});

describe("network conditions against the fixture site", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-network-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  async function drive(name: string, actions: PlannedAction[]) {
    const loaded = parseConfig(
      JSON.stringify({ baseUrl: `${site.url}/lab/news`, seed: 1, monkey: { actionTimeoutMs: 2000 } }),
    );
    const records: StepRecord[] = [];
    const outcome = await runRole(browser, undefined, loaded, {
      log: () => {},
      outputDir: join(dir, name),
      actionLog: true,
      replay: { strict: true, actions },
      onStep: (record) => {
        records.push(record);
      },
    });
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? "no error");
    return { outcome, records };
  }

  it("reports the uncaught failed request offline exactly once, and is back online one step later", async () => {
    const { outcome, records } = await drive("offline", [
      step({ type: "offline" }),
      loadNews,
      loadNews,
      step({ type: "offline" }),
      loadNews,
    ]);
    assert.deepEqual(
      outcome.findings.map((f) => [f.oracle, f.severity, f.step, f.occurrences]),
      [["pageerror", "high", 2, 2]],
    );
    assert.match(outcome.findings[0]?.message ?? "", /TypeError: Failed to fetch/);
    // Step 3 ran online again: the news loaded without an error.
    assert.deepEqual(
      records.map((r) => r.result.ok),
      [true, true, true, true, true],
    );
    const { log } = await readActionLog(outcome.actionLog ?? "", {});
    assert.equal((log as ActionLog).version, 3);
    assert.deepEqual(
      log.actions.map((a) => a.type),
      ["offline", "click", "click", "offline", "click"],
    );
  });

  it("stays silent online", async () => {
    const { outcome } = await drive("online", [loadNews, loadNews]);
    assert.deepEqual(outcome.findings, []);
  });

  it("delays every request by network.latencyMs", async () => {
    const timeLoad = async (latencyMs: number) => {
      const { config, secrets } = parseConfig(JSON.stringify({ baseUrl: site.url, seed: 1, network: { latencyMs } }));
      const session = await openRoleSession(browser, undefined, {
        config,
        secrets,
        outputDir: join(dir, `latency-${latencyMs}`),
        trace: false,
        video: false,
      });
      try {
        const started = Date.now();
        await session.page.goto(`${site.url}/clean`);
        return Date.now() - started;
      } finally {
        await session.close();
      }
    };
    const slow = await timeLoad(400);
    // The document and the favicon are two requests; at least the document waits.
    assert.ok(slow >= 400, `took ${slow}ms`);
    assert.ok((await timeLoad(0)) < 400);
  });
});
