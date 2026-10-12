import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { parseConfig } from "../src/config/config.ts";
import type { StepRecord } from "../src/monkey/loop.ts";
import type { ActionLog } from "../src/replay/log.ts";
import { describeStep, runRole } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";

async function cli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
  });
  return { code, stdout, stderr };
}

describe("spectator mode", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-watch-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** One role run on the shared headless browser; spectator mode itself does not need a visible window. */
  async function role(name: string, spectator?: { slowMoMs: number; highlightMs: number }) {
    const loaded = parseConfig(JSON.stringify({ baseUrl: site.url, seed: 4, limits: { maxSteps: 8 } }));
    const lines: string[] = [];
    const outputDir = join(dir, name);
    await runRole(browser, undefined, loaded, {
      log: (line) => lines.push(line),
      outputDir,
      actionLog: true,
      ...(spectator === undefined ? {} : { spectator }),
    });
    const log = JSON.parse(await readFile(join(outputDir, "actions.json"), "utf8")) as ActionLog;
    return { lines, actions: log.actions.map(({ type, locator, pageUrl, ok }) => ({ type, locator, pageUrl, ok })) };
  }

  it("takes the same actions as a normal run and prints every step", async () => {
    const plain = await role("plain");
    const watched = await role("watched", { slowMoMs: 0, highlightMs: 50 });
    assert.deepEqual(watched.actions, plain.actions);
    const steps = watched.lines.filter((line) => /^\[anonymous\] step \d+ monkey: /.test(line));
    assert.equal(steps.length, 8, watched.lines.join("\n"));
    assert.ok(
      steps.some((line) => line.includes("click getByRole('link', { name: 'Broken link' })")),
      steps.join("\n"),
    );
    assert.ok(!plain.lines.some((line) => / step \d+ monkey: /.test(line)));
  });

  it("describes steps with the durable locator and the outcome", () => {
    const record = (overrides: Partial<StepRecord>): StepRecord => ({
      step: 3,
      action: { type: "fill", ref: "e5", value: "monkey@test.local" },
      locator: "getByRole('textbox', { name: 'Email' })",
      url: "http://localhost/form",
      snapshotHash: "x",
      source: "llm",
      result: { ok: true, navigated: false, url: "http://localhost/form", tab: 0 },
      ...overrides,
    });
    assert.equal(
      describeStep(record({})),
      `step 3 llm: fill getByRole('textbox', { name: 'Email' }) "monkey@test.local"`,
    );
    assert.equal(
      describeStep(
        record({
          action: { type: "press", key: "Enter" },
          source: "monkey",
          result: { ok: false, error: "Timeout 5000ms exceeded.", navigated: false, url: "", tab: 0 },
        }),
      ),
      "step 3 monkey: press Enter -> failed: Timeout 5000ms exceeded.",
    );
  });

  it("validates the flags", async () => {
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ baseUrl: site.url }));
    const bad = await cli(["run", config, "--slow-mo", "fast"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--slow-mo expects milliseconds/);
    const preflight = await cli(["preflight", config, "--watch"]);
    assert.equal(preflight.code, 2);
    assert.match(preflight.stderr, /--watch and --slow-mo belong to run and replay/);
    assert.match((await cli(["--help"])).stdout, /-w, --watch {12}run, replay: spectator mode/);
  });

  const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  it("explains how to watch without a display", { skip: headless ? false : "a display is available" }, async () => {
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ baseUrl: site.url, limits: { maxSteps: 1 } }));
    const { code, stderr } = await cli(["run", config, "--watch"]);
    assert.equal(code, 2);
    assert.match(stderr, /hint: --watch opens a visible browser and needs a display; .* xvfb-run/);
    assert.ok(stderr.split("\n").length <= 3, stderr);
  });
});
