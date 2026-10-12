import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { loadConfig } from "../src/config/config.ts";
import { ACTION_TYPES } from "../src/config/schema.ts";
import { Secrets } from "../src/config/secrets.ts";
import { LocatorSyntaxError, parseLocator } from "../src/replay/locator.ts";
import { type ActionLog, ActionLogError, readActionLog } from "../src/replay/log.ts";
import { ReplayError, replayActionLog } from "../src/replay/replay.ts";
import { runAllRoles } from "../src/run.ts";
import { durableLocator, snapshot } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

const SECRET_NAME = "Sekret-Name-4711";

describe("Secrets.toPlaceholders", () => {
  it("replaces values with their placeholders in one pass, longest first", () => {
    const secrets = new Secrets([
      { name: "URL", value: "http://127.0.0.1:4000" },
      { name: "SHORT", value: "U" },
      { name: "LONG", value: "http://127.0.0.1:4000/app" },
    ]);
    assert.equal(secrets.toPlaceholders("go http://127.0.0.1:4000/app/x and U"), "go ${LONG}/x and ${SHORT}");
    assert.equal(secrets.toPlaceholders("http://127.0.0.1:4000/"), "${URL}/");
    assert.deepEqual(secrets.names, ["LONG", "SHORT", "URL"]);
    assert.equal(new Secrets([]).toPlaceholders("plain"), "plain");
  });
});

describe("parseLocator", () => {
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

  it("turns every durable locator of the fixture back into the same locator", async () => {
    const page = await browser.newPage();
    try {
      let checked = 0;
      for (const path of ["/", "/login", "/form", "/js-error", "/clean"]) {
        await page.goto(`${site.url}${path}`);
        for (const element of (await snapshot(page)).elements) {
          const text = await durableLocator(page, element.ref);
          const locator = parseLocator(page, text);
          assert.equal(locator.toString(), text);
          assert.equal(await locator.count(), 1, text);
          checked++;
        }
      }
      assert.ok(checked > 20);
    } finally {
      await page.close();
    }
  });

  it("reads chains, frames, escapes, options and regular expressions", async () => {
    const page = await browser.newPage();
    try {
      for (const text of [
        "getByRole('button', { name: 'Same' }).nth(1)",
        "getByRole('button', { name: 'Send', exact: true })",
        "getByRole('textbox', { name: 'O\\'Brien \\\\' })",
        "locator('iframe').contentFrame().getByRole('link', { name: 'Home' })",
        "getByText(/^Hello\\/ world$/i).first()",
        "getByTestId('tid')",
      ]) {
        assert.equal(parseLocator(page, text).toString(), text);
      }
    } finally {
      await page.close();
    }
  });

  it("accepts nothing but whitelisted locator methods with literal arguments", async () => {
    const page = await browser.newPage();
    try {
      for (const text of [
        "page.evaluate('1')",
        "getByRole('x').click()",
        "getByRole('x'); boom",
        "constructor('x')",
        "getByRole(x)",
        "getByRole('unterminated)",
        "locator('iframe').contentFrame()",
      ]) {
        assert.throws(() => parseLocator(page, text), LocatorSyntaxError, text);
      }
    } finally {
      await page.close();
    }
  });
});

describe("action log and replay against the fixture site", () => {
  let site: Fixture;
  let moved: Fixture;
  let dir: string;
  const env = (url: string) => ({
    FIXTURE_URL: url,
    FIXTURE_USER: FIXTURE_CREDENTIALS.username,
    FIXTURE_PASS: FIXTURE_CREDENTIALS.password,
    MONKEY_NAME: SECRET_NAME,
  });
  before(async () => {
    site = await startFixture();
    moved = await startFixture();
    dir = await mkdtemp(join(tmpdir(), "playmonkey-replay-"));
  });
  after(async () => {
    await site?.close();
    await moved?.close();
  });

  async function writeConfig(name: string, config: Record<string, unknown>): Promise<string> {
    const file = join(dir, `${name}.json`);
    await writeFile(file, JSON.stringify(config));
    return file;
  }

  async function cli(args: string[], url = site.url) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: env(url),
    });
    return { code, stdout, stderr };
  }

  /** A short anonymous run on the form that fills the Name field with a secret; returns its log file. */
  let smallLog: Promise<string> | undefined;
  function recordSmallRun(): Promise<string> {
    smallLog ??= (async () => {
      // Mostly filling, so seed 3 types the secret into "Name" (steps 5, 18 and 19), with a few clicks.
      const weights = Object.fromEntries(
        ACTION_TYPES.map((type) => [type, { fill: 10, click: 1 }[type as string] ?? 0]),
      );
      const file = await writeConfig("small", {
        baseUrl: "${FIXTURE_URL}/form",
        seed: 3,
        limits: { maxSteps: 20 },
        testData: { name: "${MONKEY_NAME}" },
        monkey: { weights },
        report: { dir: "report-small" },
      });
      const loaded = await loadConfig(file, { env: env(site.url) });
      const logs: string[] = [];
      const [outcome] = await runAllRoles(loaded, {
        log: () => {},
        // Written before onStep: the file on disk is complete JSON after every step.
        onStep: async (_role, record) => {
          const log = JSON.parse(await readFile(join(dir, "report-small", "anonymous", "actions.json"), "utf8"));
          assert.equal(log.actions.length, record.step);
          logs.push(log);
        },
      });
      assert.equal(logs.length, 20);
      assert.ok(outcome?.actionLog !== undefined);
      return outcome.actionLog;
    })();
    return smallLog;
  }

  it("records a run, and its replay reproduces the same findings, also on another host and port", async () => {
    const fixtureConfig = JSON.parse(
      await readFile(new URL("../fixtures/configs/fixture.json", import.meta.url), "utf8"),
    );
    const configFile = await writeConfig("fixture", { ...fixtureConfig, report: { dir: "report-full" } });
    const loaded = await loadConfig(configFile, { env: env(site.url) });
    const [outcome] = await runAllRoles(loaded, { log: () => {} });

    // The run reports each seeded bug exactly once, and nothing on the control pages.
    assert.equal(outcome?.result?.stopReason, "maxSteps");
    const findings = outcome?.findings ?? [];
    const keys = findings.map((f) => f.key).sort();
    assert.deepEqual(keys, [
      "console|Seeded bug: console error on load",
      "http4xx|GET /missing-page 404",
      "http5xx|POST /form 500",
      "overflow|/overflow|div",
      "pageerror|Error: Seeded bug: click handler crashed|at HTMLButtonElement.<anonymous> (/js-error:23:11)",
    ]);
    assert.deepEqual(Object.fromEntries(findings.map((f) => [f.oracle, f.severity])), {
      console: "medium",
      http4xx: "medium",
      http5xx: "high",
      overflow: "low",
      pageerror: "high",
    });
    for (const finding of findings) {
      assert.equal(finding.role, "user");
      // baseUrl comes from ${FIXTURE_URL}, so it is masked like every substituted value.
      assert.match(finding.url, /^\*\*\*\//);
      assert.doesNotMatch(finding.url, /^\*\*\*\/(clean|login|account)$/);
      assert.ok((await stat(finding.screenshotPath ?? "")).size > 0, `${finding.id} has a screenshot`);
      assert.equal(finding.lastActions.length, Math.min(10, finding.step));
      assert.equal(finding.lastActions.at(-1)?.step, finding.step);
    }

    // The log has every step, durable locators and placeholders instead of the site URL and the login.
    const logFile = outcome?.actionLog ?? "";
    const text = await readFile(logFile, "utf8");
    const log = JSON.parse(text) as ActionLog;
    assert.equal(log.version, 2);
    assert.equal(log.baseUrl, "${FIXTURE_URL}");
    assert.equal(log.actions.length, 300);
    assert.deepEqual(log.findings.map((f) => f.key).sort(), keys);
    assert.ok(log.actions.every((a) => a.source === "monkey" && a.pageUrl.startsWith("${FIXTURE_URL}")));
    assert.ok(log.actions.filter((a) => "ref" in a).every((a) => a.locator !== undefined));
    assert.ok(!(text.includes(site.url) || text.includes(FIXTURE_CREDENTIALS.password)));

    // Replay on a second fixture instance: only FIXTURE_URL changes.
    const { code, stdout } = await cli(["replay", "--config", configFile, logFile], moved.url);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\[user\] replaying 300 actions\n/);
    assert.match(stdout, /\[user\] 300 steps in .*, stopped: end, 5 findings\n/);
    assert.equal(stdout.match(/^reproduced {6}F\d /gm)?.length, 5);
    assert.match(stdout, /\nreproduced: 5 of 5\n$/);
    assert.ok((await stat(join(dir, "report-full", "user", "replay", "trace.zip"))).size > 0);
  });

  it("stores secrets typed into fields as their placeholder", async () => {
    const text = await readFile(await recordSmallRun(), "utf8");
    assert.ok(!text.includes(SECRET_NAME), "the secret value is not in the log");
    const log = JSON.parse(text) as ActionLog;
    assert.ok(log.actions.some((a) => a.type === "fill" && a.value === "${MONKEY_NAME}"));
    assert.ok(log.placeholders.includes("MONKEY_NAME"));
  });

  it("replays without a config and without any LLM, resolving placeholders from the environment", async () => {
    const result = await replayActionLog(await recordSmallRun(), { strict: false, env: env(site.url), log: () => {} });
    assert.equal(result.outcome.result?.stopReason, "end");
    assert.equal(result.outcome.result?.steps, 20);
    assert.equal(result.outcome.result?.skippedActions, 0);
    assert.ok(result.original.every((finding) => finding.reproduced));
    assert.deepEqual(result.added, []);
  });

  it("names missing environment variables", async () => {
    await assert.rejects(
      replayActionLog(await recordSmallRun(), { strict: false, env: { FIXTURE_URL: site.url }, log: () => {} }),
      (error: Error) => error instanceof ActionLogError && /MONKEY_NAME not set/.test(error.message),
    );
  });

  it("skips actions whose element is gone and continues, or aborts with --strict", async () => {
    const log = JSON.parse(await readFile(await recordSmallRun(), "utf8")) as ActionLog;
    const index = log.actions.findIndex((a) => a.locator !== undefined);
    log.actions[index] = { ...log.actions[index], locator: "getByRole('button', { name: 'Gone' })" } as never;
    await mkdir(join(dir, "drifted"), { recursive: true });
    const drifted = join(dir, "drifted", "actions.json");
    await writeFile(drifted, JSON.stringify(log));

    const lenient = await cli(["replay", drifted]);
    assert.match(lenient.stdout, new RegExp(`step ${index + 1} skipped: element not found: getByRole`));
    assert.match(lenient.stdout, /20 steps in .*, 1 skipped, stopped: end/);

    const strict = await cli(["replay", "--strict", drifted]);
    assert.equal(strict.code, 2);
    assert.match(strict.stdout, new RegExp(`stopped: error: step ${index + 1}: element not found`));
  });

  it("rejects unsupported versions and broken logs with a clear message", async () => {
    const write = async (name: string, content: unknown) => {
      const file = join(dir, `${name}.actions.json`);
      await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
      return file;
    };
    const v3 = await cli(["replay", await write("v3", { version: 3, actions: [] })]);
    assert.equal(v3.code, 2);
    assert.match(v3.stderr, /unsupported version 3; this monkey reads versions 1 and 2/);

    const base = { version: 1, seed: 1, baseUrl: site.url, role: "anonymous", viewport: [800, 600], placeholders: [] };
    const bad = await cli([
      "replay",
      await write("bad", {
        ...base,
        findings: [],
        actions: [{ step: 1, source: "monkey", type: "dance", pageUrl: "/", snapshotHash: "h", ok: true }],
      }),
    ]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /actions\[0\]: unknown action type "dance"/);

    const json = await cli(["replay", await write("json", "{ nope")]);
    assert.match(json.stderr, /invalid JSON/);

    await assert.rejects(
      readActionLog(
        await write("fill", {
          ...base,
          findings: [],
          actions: [{ step: 1, source: "monkey", type: "fill", ref: "e1", pageUrl: "/", snapshotHash: "h", ok: true }],
        }),
        {},
      ),
      /actions\[0\]: fill needs value \(string\)/,
    );
  });

  it("needs --config to replay a role that logs in", async () => {
    const log = JSON.parse(await readFile(await recordSmallRun(), "utf8")) as ActionLog;
    const file = join(dir, "role.actions.json");
    await writeFile(file, JSON.stringify({ ...log, role: "admin" }));
    await assert.rejects(
      replayActionLog(file, { strict: false, env: env(site.url), log: () => {} }),
      (error: Error) => error instanceof ReplayError && /pass --config with that role/.test(error.message),
    );
  });
});
