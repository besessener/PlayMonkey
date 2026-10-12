import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { BROKEN_DOWNLOAD_BYTES } from "../fixtures/site/lab.ts";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { openRoleSession } from "../src/auth/session.ts";
import { parseConfig } from "../src/config/config.ts";
import { ACTION_TYPES, type ActionType } from "../src/config/schema.ts";
import type { Action } from "../src/monkey/actions.ts";
import { chooseAction, Exploration } from "../src/monkey/chooser.ts";
import type { StepEvent } from "../src/monkey/events.ts";
import { type PlannedAction, runMonkey, type StepRecord } from "../src/monkey/loop.ts";
import { Random } from "../src/monkey/random.ts";
import { Oracles } from "../src/oracles/oracles.ts";
import { type ActionLog, readActionLog } from "../src/replay/log.ts";
import { replayActionLog } from "../src/replay/replay.ts";
import { runRole } from "../src/run.ts";
import { snapshot } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

/** A scripted step: the action and the durable locator(s) it acts on. */
const step = (action: Action, locator?: string, toLocator?: string): PlannedAction => ({
  action,
  source: "monkey",
  ...(locator === undefined ? {} : { locator }),
  ...(toLocator === undefined ? {} : { toLocator }),
});
const click = (locator: string) => step({ type: "click", ref: "x" }, locator);
const button = (name: string) => `getByRole('button', { name: '${name}' })`;
const link = (name: string) => `getByRole('link', { name: '${name}' })`;

describe("the lab: hard parts of real pages", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-lab-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /**
   * Runs scripted actions through the real loop (as a replay plan), with the stayOnDomain guard, the page events and
   * the oracles. The context stays open for assertions; close it with `done`.
   */
  async function drive(path: string, actions: PlannedAction[], extra: Record<string, unknown> = {}) {
    const { config, secrets } = parseConfig(
      JSON.stringify({ baseUrl: `${site.url}${path}`, seed: 1, monkey: { actionTimeoutMs: 2000 }, ...extra }),
    );
    const outputDir = await mkdtemp(join(dir, "drive-"));
    const session = await openRoleSession(browser, undefined, {
      config,
      secrets,
      outputDir,
      trace: false,
      video: false,
    });
    const oracles = new Oracles(session.context, {
      config,
      role: "anonymous",
      screenshotDir: join(outputDir, "shots"),
    });
    const records: StepRecord[] = [];
    const downloadDir = join(outputDir, "downloads");
    const result = await runMonkey(session.context, {
      config,
      downloadDir,
      replay: { strict: true, actions },
      onStep: async (record) => {
        records.push(record);
        const pages = session.context.pages();
        await oracles.check(record, pages[record.result.tab] ?? pages[0]);
      },
    });
    const findings = await oracles.finish();
    const events = records.flatMap((record) => record.events ?? []);
    return { result, records, findings, events, context: session.context, downloadDir, done: () => session.close() };
  }

  it("answers every native dialog, also one that blocks the page from loading", async () => {
    const run = await drive("/lab/dialogs", [
      click(button("Show alert")),
      click(button("Delete everything")),
      click(button("Rename")),
      step({ type: "check", ref: "x" }, "getByRole('checkbox', { name: 'Warn before leaving' })"),
      step({ type: "navigate", url: `${site.url}/lab/alert-on-load` }),
      step({ type: "scroll", deltaY: 300 }),
    ]);
    try {
      assert.equal(run.result.stopReason, "end", run.result.error);
      assert.deepEqual(
        run.records.map((r) => [r.step, r.result.ok]),
        [
          [1, true],
          [2, true],
          [3, true],
          [4, true],
          [5, true],
          [6, true],
        ],
      );
      const dialogs = run.events.filter((e): e is Extract<StepEvent, { kind: "dialog" }> => e.kind === "dialog");
      assert.deepEqual(
        dialogs.map((d) => [d.dialog, d.message]),
        [
          ["alert", "Hello from the lab"],
          ["confirm", "Really delete everything?"],
          ["prompt", "New name?"],
          ["beforeunload", ""],
          ["alert", "Welcome to the lab"],
        ].slice(0, dialogs.length),
      );
      // beforeunload may be dismissed, which keeps the page; then the alert page is never reached.
      const leave = dialogs[3];
      assert.ok(leave !== undefined && leave.dialog === "beforeunload");
      assert.equal(dialogs.length, leave.accepted ? 5 : 4);
      assert.equal(run.findings.length, 0);
    } finally {
      await run.done();
    }
  });

  it("reports a bug inside a same-origin iframe and counts the cross-origin one", async () => {
    const run = await drive("/lab/frames", [
      click("getByTitle('Inner frame').contentFrame().getByRole('button', { name: 'Crash in frame' })"),
      click("getByTitle('Inline frame').contentFrame().getByRole('button', { name: 'Press me' })"),
    ]);
    try {
      assert.equal(run.result.stopReason, "end", run.result.error);
      assert.ok(run.records.every((r) => r.result.ok));
      assert.deepEqual(
        run.findings.map((f) => [f.oracle, f.message, f.step]),
        [["pageerror", "Error: Seeded bug: frame handler crashed", 1]],
      );
      const page = run.context.pages()[0];
      assert.ok(page !== undefined);
      const snap = await snapshot(page);
      assert.equal(snap.crossOriginFrames, 1);
      assert.ok(snap.elements.some((e) => e.name === "Crash in frame" && e.inFrame));
      assert.ok(!snap.elements.some((e) => e.name === "Out of reach"));
    } finally {
      await run.done();
    }
  });

  it("follows popups, reports their bugs, closes off-site ones and keeps the tab count down", async () => {
    const run = await drive(
      "/lab/popups",
      [
        click(link("Details in a new tab")),
        step({ type: "switchTab", index: 0 }),
        click(link("External site")),
        click(button("Open a window that closes itself")),
        step({ type: "scroll", deltaY: 100 }),
        ...Array.from({ length: 3 }, () => [
          step({ type: "switchTab", index: 0 }),
          click(button("Open a window")),
        ]).flat(),
      ],
      { monkey: { actionTimeoutMs: 2000, maxTabs: 3 } },
    );
    try {
      assert.equal(run.result.stopReason, "end", run.result.error);
      const [first, , external] = run.records;
      // The monkey continues in the popup it opened.
      assert.equal(first?.result.tab, 1);
      assert.match(first?.result.url ?? "", /\/lab\/popup-inner$/);
      // The off-site popup was blocked by stayOnDomain and closed; the monkey went on in the first tab.
      assert.equal(external?.result.ok, true);
      assert.ok(run.records.slice(3).every((r) => !/example\.invalid/.test(r.url)));
      const keys = [...new Set(run.findings.map((f) => `${f.oracle}|${f.message}`))];
      assert.deepEqual(keys, ["pageerror|Error: Seeded bug: popup failed to initialise"]);
      assert.ok(run.findings.every((f) => f.occurrences >= 1));
      assert.ok(run.context.pages().length <= 3, `${run.context.pages().length} tabs open`);
      assert.ok(run.context.pages().every((p) => p.url().startsWith(site.url)));
    } finally {
      await run.done();
    }
  });

  it("uploads generated files through file inputs and custom buttons", async () => {
    const actions = [click(button("Document")), click(button("Attachments")), click(button("Upload avatar"))];
    const run = await drive("/lab/upload", actions);
    try {
      assert.equal(run.result.stopReason, "end", run.result.error);
      const uploads = run.records.map((r) => r.events?.find((e) => e.kind === "upload"));
      assert.ok(
        uploads.every((u) => u !== undefined && u.files.length >= 1),
        JSON.stringify(uploads),
      );
      const page = run.context.pages()[0];
      const listed = (await page?.getByRole("list", { name: "Chosen files" }).innerText()) ?? "";
      for (const [index, id] of ["document", "attachments", "avatar"].entries()) {
        const upload = uploads[index];
        assert.ok(upload?.kind === "upload");
        for (const name of upload.files) assert.ok(listed.includes(`${id}: ${name}`), `${id}: ${name} in ${listed}`);
      }
      assert.equal(run.findings.length, 0);
    } finally {
      await run.done();
    }
  });

  it("saves downloads and reports a broken one", async () => {
    const run = await drive("/lab/download", [click(link("Download the report")), click(link("Download the export"))]);
    try {
      assert.equal(run.result.stopReason, "end", run.result.error);
      const downloads = run.events.filter((e) => e.kind === "download");
      assert.deepEqual(downloads, [
        { kind: "download", name: "report.csv", url: `${site.url}/lab/files/report.csv`, size: 29 },
        { kind: "download", name: "export.zip", url: `${site.url}/lab/files/export.zip`, failure: "canceled" },
      ]);
      assert.deepEqual(
        run.findings.map((f) => [f.oracle, f.severity, f.key, f.step]),
        [["download", "medium", "download|/lab/files/export.zip", 2]],
      );
      assert.match(
        run.findings[0]?.message ?? "",
        /^download of export\.zip from \/lab\/files\/export\.zip failed: canceled$/,
      );
      const saved = await readdir(run.downloadDir);
      assert.deepEqual(saved, ["step-0001-1-report.csv"]);
      assert.ok(BROKEN_DOWNLOAD_BYTES > 0);
    } finally {
      await run.done();
    }
  });

  it("hovers, double-clicks, right-clicks, drags and long-presses", async () => {
    const run = await drive("/lab/widgets", [
      step({ type: "hover", ref: "x" }, button("Products")),
      click(link("Apples")),
      step({ type: "dblclick", ref: "x" }, button("Double-click to edit")),
      step({ type: "rightclick", ref: "x" }, button("Right-click for options")),
      click("getByRole('menuitem', { name: 'Copy' })"),
      step({ type: "drag", ref: "x", toRef: "y" }, button("Card A"), "getByRole('region', { name: 'Done' })"),
      step({ type: "longPress", ref: "x" }, button("Hold to confirm")),
    ]);
    try {
      assert.equal(run.result.stopReason, "end", run.result.error);
      assert.deepEqual(
        run.records.filter((r) => !r.result.ok).map((r) => [r.step, r.result.error]),
        [],
      );
      const page = run.context.pages()[0];
      assert.ok(page !== undefined);
      assert.match(page.url(), /\?item=apples$/);
      assert.equal(await page.getByRole("textbox", { name: "Title" }).count(), 1);
      assert.equal(await page.locator("#count").textContent(), "1");
      assert.equal(await page.getByRole("status").textContent(), "Confirmed.");
      assert.equal(run.findings.length, 0);
    } finally {
      await run.done();
    }
  });

  it("prefers the buttons of a consent banner that covers the page", async () => {
    const context = await browser.newContext({ baseURL: site.url });
    try {
      const page = await context.newPage();
      await page.goto("/lab/consent");
      const snap = await snapshot(page);
      assert.deepEqual(snap.dialogs, ["Cookie consent"]);
      assert.deepEqual(
        snap.elements.filter((e) => e.inDialog).map((e) => e.name),
        ["Accept all", "Reject all"],
      );
      const weights = Object.fromEntries(ACTION_TYPES.map((t) => [t, t === "click" ? 1 : 0])) as Record<
        ActionType,
        number
      >;
      const random = new Random(5);
      const picks = Array.from({ length: 50 }, () => {
        const { action } = chooseAction(snap, new Exploration(), random, {
          weights,
          testData: {},
          tabCount: 1,
          currentTab: 0,
          viewport: { width: 1280, height: 800 },
        });
        return snap.elements.find((e) => "ref" in action && e.ref === action.ref)?.inDialog === true;
      });
      // 2 buttons, 10 times as likely, against "Show offers" and two links to unvisited pages (3 times as likely):
      // 20 of 27, about 37 of 50 picks; without the bonus it would be 2 of 9, about 11.
      assert.ok(picks.filter(Boolean).length >= 30, `${picks.filter(Boolean).length} of 50`);
    } finally {
      await context.close();
    }
  });

  it("records the new actions and page events in actions.json and replays them with the same answers", async () => {
    const { config, secrets } = parseConfig(
      JSON.stringify({ baseUrl: `${site.url}/lab/dialogs`, seed: 2, monkey: { actionTimeoutMs: 2000 } }),
    );
    const outputDir = join(dir, "record");
    const outcome = await runRole(
      browser,
      undefined,
      { config, secrets },
      {
        log: () => {},
        outputDir,
        actionLog: true,
        replay: {
          strict: true,
          actions: [
            click(button("Delete everything")),
            click(button("Rename")),
            click(button("Show alert")),
            step({ type: "hover", ref: "x" }, button("Rename")),
            step({ type: "navigate", url: `${site.url}/lab/download` }),
            click(link("Download the export")),
            step({ type: "navigate", url: `${site.url}/lab/widgets` }),
            step({ type: "drag", ref: "x", toRef: "y" }, button("Card B"), "getByRole('region', { name: 'Done' })"),
            step({ type: "dblclick", ref: "x" }, button("Double-click to edit")),
          ],
        },
      },
    );
    assert.ok(outcome.actionLog !== undefined);
    const log = JSON.parse(await readFile(outcome.actionLog, "utf8")) as ActionLog;
    assert.equal(log.version, 2);
    assert.deepEqual(
      log.actions.map((a) => a.type),
      ["click", "click", "click", "hover", "navigate", "click", "navigate", "drag", "dblclick"],
    );
    const drag = log.actions[7];
    assert.equal(drag?.toLocator, "getByRole('region', { name: 'Done' })");
    const recorded = log.actions.flatMap((a) => a.events ?? []);
    assert.deepEqual(
      recorded.filter((e) => e.kind === "dialog").map((e) => e.dialog),
      ["confirm", "prompt", "alert"],
    );
    assert.deepEqual(
      log.findings.map((f) => f.oracle),
      ["download"],
    );
    // Downloads are measured and then deleted unless report.keepDownloads.
    await assert.rejects(readdir(join(outputDir, "downloads")), /ENOENT/);

    // The replay gives the recorded answers again, though its seed for page events is another one.
    const edited = { ...log, seed: 99 };
    await writeFile(outcome.actionLog, JSON.stringify(edited));
    const replayed = await replayActionLog(outcome.actionLog, { strict: true, env: {}, log: () => {} });
    assert.equal(replayed.outcome.result?.stopReason, "end");
    assert.deepEqual(
      replayed.original.map((f) => [f.oracle, f.reproduced]),
      [["download", true]],
    );
    const again = JSON.parse(await readFile(outcome.actionLog, "utf8")) as ActionLog;
    assert.equal(again.seed, 99);
    const page = await readActionLog(outcome.actionLog, {});
    assert.equal(page.log.actions.length, 9);
  });

  it("still reads and replays version 1 logs", async () => {
    const file = join(dir, "v1.actions.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        seed: 1,
        baseUrl: site.url,
        role: "anonymous",
        viewport: [1280, 800],
        placeholders: [],
        actions: [
          {
            step: 1,
            source: "monkey",
            type: "click",
            ref: "e1",
            locator: "getByRole('link', { name: 'Broken link' })",
            pageUrl: `${site.url}/`,
            snapshotHash: "h",
            ok: true,
          },
        ],
        findings: [
          {
            id: "F1",
            oracle: "http4xx",
            severity: "medium",
            key: "http4xx|GET /missing-page 404",
            message: "x",
            step: 1,
          },
        ],
      }),
    );
    const replayed = await replayActionLog(file, { strict: true, env: {}, log: () => {} });
    assert.deepEqual(
      replayed.original.map((f) => f.reproduced),
      [true],
    );
  });
});
