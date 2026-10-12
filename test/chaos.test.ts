import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { parseConfig } from "../src/config/config.ts";
import type { StepEvent } from "../src/monkey/events.ts";
import type { StepRecord } from "../src/monkey/loop.ts";
import { runRole } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i);
const MAX_STEPS = 30;
const MAX_MINUTES = 1.5;
/** Roles run side by side in one browser, like separate users. */
const PARALLEL = 4;

describe("chaos: 20 seeds on the full fixture", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-chaos-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  async function chaos(seed: number) {
    const loaded = parseConfig(
      JSON.stringify({
        // The lab links to the main site, so both are reachable.
        baseUrl: `${site.url}/lab`,
        seed,
        limits: { maxSteps: MAX_STEPS, maxMinutes: MAX_MINUTES },
        monkey: { actionTimeoutMs: 1500 },
      }),
    );
    const records: StepRecord[] = [];
    const outcome = await runRole(browser, undefined, loaded, {
      log: () => {},
      outputDir: join(dir, String(seed)),
      actionLog: false,
      onStep: (record) => {
        records.push(record);
      },
    });
    return { seed, outcome, records };
  }

  it("never crashes the tool, stays within maxMinutes and leaves no dialog unanswered", async () => {
    const runs: Awaited<ReturnType<typeof chaos>>[] = [];
    for (let i = 0; i < SEEDS.length; i += PARALLEL) {
      runs.push(...(await Promise.all(SEEDS.slice(i, i + PARALLEL).map(chaos))));
    }

    const events: StepEvent[] = [];
    for (const { seed, outcome, records } of runs) {
      const result = outcome.result;
      assert.ok(result !== undefined, `seed ${seed}: ${outcome.error}`);
      assert.equal(result.stopReason, "maxSteps", `seed ${seed}: ${result.error}`);
      assert.equal(result.steps, MAX_STEPS);
      assert.ok(result.durationMs < MAX_MINUTES * 60_000, `seed ${seed} took ${result.durationMs} ms`);
      // An unanswered dialog blocks the page: every later action would time out, and the page would hang.
      const findings = outcome.findings.map((f) => f.oracle);
      assert.ok(!findings.includes("crash") && !findings.includes("hang"), `seed ${seed}: ${findings.join(", ")}`);
      events.push(...records.flatMap((r) => r.events ?? []));
    }
    const answered = events.filter((e) => e.kind === "dialog");
    assert.ok(answered.every((e) => typeof e.accepted === "boolean"));
    // Sanity: the monkeys did meet the lab's dialogs.
    assert.ok(answered.length > 0, "no dialog in 20 runs");
  });
});
