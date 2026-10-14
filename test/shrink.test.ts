import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { parseConfig } from "../src/config/config.ts";
import type { PlannedAction } from "../src/monkey/loop.ts";
import { ddmin } from "../src/replay/ddmin.ts";
import type { ActionLog } from "../src/replay/log.ts";
import { runRole } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";

describe("ddmin", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const needs =
    (...required: number[]) =>
    (subset: number[]) =>
      Promise.resolve(required.every((item) => subset.includes(item)));

  it("finds the items the failure needs, in their order", async () => {
    const result = await ddmin(range(10), needs(3, 7), { maxTests: 100 });
    assert.deepEqual(result.items, [3, 7]);
    assert.equal(result.stoppedEarly, false);
    assert.deepEqual((await ddmin(range(16), needs(5), { maxTests: 100 })).items, [5]);
    assert.deepEqual((await ddmin(range(9), needs(0, 4, 8), { maxTests: 200 })).items, [0, 4, 8]);
  });

  it("never tests the same subset twice", async () => {
    const tried = new Set<string>();
    await ddmin(
      range(12),
      (subset) => {
        const key = subset.join(",");
        assert.ok(!tried.has(key), `tested ${key} twice`);
        tried.add(key);
        return Promise.resolve(subset.includes(2) && subset.includes(9));
      },
      { maxTests: 200 },
    );
  });

  it("stops at the budget or when asked, with a result that still fails", async () => {
    const budget = await ddmin(range(20), needs(1, 18), { maxTests: 3 });
    assert.equal(budget.tests, 3);
    assert.equal(budget.stoppedEarly, true);
    assert.ok(budget.items.includes(1) && budget.items.includes(18));

    const stopped = await ddmin(range(20), needs(1, 18), { maxTests: 100, stop: () => true });
    assert.deepEqual(stopped, { items: range(20), tests: 0, stoppedEarly: true });
    assert.deepEqual(await ddmin([4], needs(4), { maxTests: 5 }), { items: [4], tests: 0, stoppedEarly: false });
  });
});

describe("monkey shrink against the fixture site", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  let logFile: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-shrink-"));
    logFile = await record();
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

  /** A run that reaches the form's HTTP 500 (empty name) on a detour of eight actions, two of which matter. */
  async function record(): Promise<string> {
    const loaded = parseConfig(JSON.stringify({ baseUrl: "${FIXTURE_URL}", seed: 1 }), {
      env: { FIXTURE_URL: site.url },
    });
    const outcome = await runRole(browser, undefined, loaded, {
      log: () => {},
      outputDir: join(dir, "recorded"),
      actionLog: true,
      artifacts: false,
      replay: {
        strict: true,
        actions: [
          step({ type: "scroll", deltaY: 300 }),
          step({ type: "hover", ref: "x" }, "getByRole('link', { name: 'Clean page' })"),
          step({ type: "click", ref: "x" }, "getByRole('link', { name: 'Contact form' })"),
          step({ type: "fill", ref: "x", value: "a@b.cd" }, "getByRole('textbox', { name: 'Email' })"),
          step({ type: "press", key: "Tab" }),
          step({ type: "check", ref: "x" }, "getByRole('checkbox', { name: 'Subscribe to the newsletter' })"),
          step({ type: "scroll", deltaY: -300 }),
          step({ type: "click", ref: "x" }, "getByRole('button', { name: 'Send' })"),
        ],
      },
    });
    assert.deepEqual(
      outcome.findings.map((f) => f.key),
      ["http5xx|POST /form 500"],
    );
    return outcome.actionLog ?? "";
  }

  async function cli(args: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: { FIXTURE_URL: site.url },
    });
    return { code, stdout, stderr };
  }

  it("shortens the way to the finding to the two actions it needs, and the result replays", async () => {
    // A missing element costs a whole action timeout, and shrinking misses many on purpose.
    const config = join(dir, "fast.json");
    await writeFile(config, JSON.stringify({ baseUrl: "${FIXTURE_URL}", monkey: { actionTimeoutMs: 1000 } }));
    const { code, stdout } = await cli(["shrink", "--config", config, logFile]);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^F1 http5xx: POST \/form responded 500 Internal Server Error\n/);
    assert.match(stdout, /\n {2}replay 1: 8 actions, reproduced\n/);
    assert.match(stdout, /\nshrunk {2}F1 http5xx: 8 -> 2 actions, \d+ replays\n$/);

    const shrunk = join(dir, "recorded", "shrink", "F1.actions.json");
    const log = JSON.parse(await readFile(shrunk, "utf8")) as ActionLog;
    assert.deepEqual(
      log.actions.map((a) => [a.step, a.type, a.locator]),
      [
        [1, "click", "getByRole('link', { name: 'Contact form' })"],
        [2, "click", "getByRole('button', { name: 'Send' })"],
      ],
    );
    assert.equal(log.baseUrl, "${FIXTURE_URL}", "placeholders stay placeholders");
    assert.deepEqual(
      log.findings.map((f) => [f.id, f.key, f.step]),
      [["F1", "http5xx|POST /form 500", 2]],
    );

    const replayed = await cli(["replay", shrunk]);
    assert.equal(replayed.code, 1, replayed.stdout);
    assert.match(replayed.stdout, /\nreproduced: 1 of 1\n$/);
  });

  it("says when the budget ran out before the result was minimal", async () => {
    const { code, stdout } = await cli(["shrink", "--finding", "F1", "--max-replays", "2", logFile]);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\nshrunk {2}F1 http5xx: 8 -> \d actions \(stopped early, may shrink further\), 2 replays\n$/);
  });

  it("rejects an unknown finding, a bad budget and options of other commands", async () => {
    const unknown = await cli(["shrink", "--finding", "F9", logFile]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^monkey shrink: no finding F9 in the log; it has F1\n/);

    const budget = await cli(["shrink", "--max-replays", "1", logFile]);
    assert.equal(budget.code, 2);
    assert.match(budget.stderr, /--max-replays expects 2 … 1000, got "1"/);

    const strict = await cli(["shrink", "--strict", logFile]);
    assert.equal(strict.code, 2);
    assert.match(strict.stderr, /^monkey shrink: --strict belongs to replay\n/);

    const wrong = await cli(["run", "--finding", "F1", logFile]);
    assert.match(wrong.stderr, /^monkey run: --finding belongs to shrink\n/);
  });
});
