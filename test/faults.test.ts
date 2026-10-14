import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { ACTION_TYPES, type ActionType } from "../src/config/values.ts";
import type { PlannedAction, StepAdvisor } from "../src/monkey/loop.ts";
import { launchChromium } from "./helpers/browser.ts";
import { button, click, drive, link, step } from "./helpers/drive.ts";

/** Only this action type, so a random run does what the test needs. */
const only = (type: ActionType) => ({
  monkey: { actionTimeoutMs: 1000, weights: Object.fromEntries(ACTION_TYPES.map((t) => [t, t === type ? 1 : 0])) },
});

describe("faults: pages and connections that stop working", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-faults-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  const run = (path: string, actions?: PlannedAction[], extra: Record<string, unknown> = {}) =>
    drive({ browser, baseUrl: `${site.url}${path}`, dir, ...(actions === undefined ? {} : { actions }), extra });

  const keys = (findings: { key: string; occurrences: number }[]) => findings.map((f) => [f.key, f.occurrences]);

  it("reports an error page with status 200 once per page, however often it is visited", async () => {
    const result = await run("/lab/faults", [
      click(link("Old offer")),
      step({ type: "back" }),
      click(link("Old offer")),
    ]);
    try {
      assert.equal(result.result.stopReason, "end", result.result.error ?? "no error");
      assert.deepEqual(keys(result.findings), [["errorPage|/lab/faults/soft-404|200", 2]]);
      assert.equal(result.findings[0]?.severity, "medium");
    } finally {
      await result.done();
    }
  });

  it("reports a link whose page never answers once, keyed by that page, not by where the click came from", async () => {
    const result = await run(
      "/lab/faults/slow",
      [
        click(link("Open the report")),
        step({ type: "navigate", url: `${site.url}/lab/faults` }),
        step({ type: "navigate", url: `${site.url}/lab/faults/never` }),
      ],
      { monkey: { actionTimeoutMs: 1000 } },
    );
    try {
      assert.equal(result.result.stopReason, "end", result.result.error ?? "no error");
      assert.deepEqual(
        result.records.map((r) => r.result.hang),
        [`${site.url}/lab/faults/never`, undefined, `${site.url}/lab/faults/never`],
      );
      assert.deepEqual(keys(result.findings), [["hang|navigation|/lab/faults/never", 2]]);
      assert.equal(result.findings[0]?.severity, "high");
    } finally {
      await result.done();
    }
  });

  it("reports a connection the server drops once, before the monkey leaves the browser's error page", async () => {
    const result = await run("/lab/faults/reset", [
      click(link("Load the data")),
      step({ type: "scroll", deltaY: 100 }),
      click(link("Load the data")),
    ]);
    try {
      assert.equal(result.result.stopReason, "end", result.result.error ?? "no error");
      assert.equal(result.findings.length, 1, JSON.stringify(keys(result.findings)));
      const [finding] = result.findings;
      assert.match(finding?.key ?? "", /^errorPage\|\/lab\/faults\/crash\|net::ERR_[A-Z_]+$/);
      assert.equal(finding?.severity, "high");
      assert.equal(finding?.occurrences, 2);
    } finally {
      await result.done();
    }
  });

  it("reports a page that freezes on a click once, replaces it and carries on", async () => {
    const result = await run(
      "/lab/faults/busy",
      [click(button("Recalculate")), step({ type: "scroll", deltaY: 100 }), click(button("Recalculate"))],
      { monkey: { actionTimeoutMs: 1000 } },
    );
    try {
      assert.equal(result.result.stopReason, "end", result.result.error ?? "no error");
      assert.equal(result.records.length, 3);
      assert.deepEqual(keys(result.findings), [["hang|unresponsive|/lab/faults/busy", 2]]);
    } finally {
      await result.done();
    }
  });

  it("ends a random run on a page that freezes on every key press, with the freeze reported once", async () => {
    const result = await run("/lab/faults/busy", undefined, { limits: { maxSteps: 4 }, ...only("press") });
    try {
      assert.equal(result.result.stopReason, "maxSteps", result.result.error ?? "no error");
      assert.deepEqual(
        result.findings.map((f) => f.key),
        ["hang|unresponsive|/lab/faults/busy"],
      );
    } finally {
      await result.done();
    }
  });

  it("does not report going back as a hang when an unsaved-changes guard was dismissed", async () => {
    const result = await run("/lab/faults", [
      click(link("Unsaved changes")),
      step({ type: "check", ref: "x" }, "getByRole('checkbox', { name: 'I changed something' })"),
      {
        ...step({ type: "back" }),
        events: [{ kind: "dialog", dialog: "beforeunload", message: "", accepted: false }],
      },
    ]);
    try {
      assert.equal(result.result.stopReason, "end", result.result.error ?? "no error");
      const back = result.records[2];
      assert.deepEqual(
        back?.events?.map((e) => e.kind === "dialog" && [e.dialog, e.accepted]),
        [["beforeunload", false]],
      );
      assert.equal(back?.result.hang, undefined);
      assert.deepEqual(result.findings, []);
    } finally {
      await result.done();
    }
  });

  it("keeps exploring a page with a malformed link", async () => {
    const result = await run("/lab/faults/bad-link", undefined, { limits: { maxSteps: 5 }, ...only("hover") });
    try {
      assert.equal(result.result.stopReason, "maxSteps", result.result.error ?? "no error");
      assert.equal(result.records.length, 5);
    } finally {
      await result.done();
    }
  });

  it("ends a step that never finishes at maxMinutes or on the signal", async () => {
    const never: StepAdvisor = { observe: () => undefined, choose: () => new Promise(() => undefined), record() {} };
    const timed = await drive({
      browser,
      baseUrl: `${site.url}/clean`,
      dir,
      advisor: never,
      extra: { limits: { maxMinutes: 0.02 } },
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    const aborted = await drive({ browser, baseUrl: `${site.url}/clean`, dir, advisor: never, signal: abort.signal });
    try {
      assert.deepEqual([timed.result.stopReason, timed.result.steps], ["maxMinutes", 0]);
      assert.ok(timed.result.durationMs < 5000, `${timed.result.durationMs}ms`);
      assert.deepEqual([aborted.result.stopReason, aborted.result.steps], ["aborted", 0]);
    } finally {
      await timed.done();
      await aborted.done();
    }
  });
});
