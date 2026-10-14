import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { parseConfig } from "../src/config/config.ts";
import { runRole } from "../src/run.ts";
import { roleDirectory } from "../src/run-plan.ts";
import { launchChromium } from "./helpers/browser.ts";

describe("monkey run against the fixture site", () => {
  let site: Fixture;
  let dir: string;
  before(async () => {
    site = await startFixture();
    dir = await mkdtemp(join(tmpdir(), "monkey-run-"));
  });
  after(() => site?.close());

  const role = (name: string, password: string) => ({
    name,
    loginUrl: "/login",
    fields: { username: "${FIXTURE_USER}", password },
    submit: "button[type=submit]",
  });

  async function run(config: Record<string, unknown>) {
    const file = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify({ baseUrl: site.url, seed: 4, limits: { maxSteps: 8 }, ...config }));
    let stdout = "";
    let stderr = "";
    const code = await runCli(["run", file], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: {
        FIXTURE_USER: FIXTURE_CREDENTIALS.username,
        FIXTURE_PASS: FIXTURE_CREDENTIALS.password,
        WRONG: "nope-123",
      },
    });
    return { code, stdout, stderr };
  }

  it("logs in, runs the monkey for the role and writes its trace", async () => {
    const { code, stdout } = await run({ auth: [role("user", "${FIXTURE_PASS}")], report: { dir: "out-ok" } });
    // Seed 4 follows the broken link within 8 steps.
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^seed: 4\n\[user\] starting\n/);
    assert.match(stdout, /\[user\] 8 steps in [\d.]+s, \d+ states, \d+ failed actions, stopped: maxSteps, 1 finding\n/);
    assert.match(stdout, /\[user\] {3}F1 medium http4xx: GET \/missing-page responded 404 Not Found \(step \d\)\n/);
    assert.match(
      stdout,
      /\nfindings: 1 \(1 medium\)\ncoverage: [1-9]\d* pages visited, \d+ linked pages never visited\nreport: .*out-ok[\\/]report\.html\nexit 1: findings present\n$/,
    );
    assert.ok((await stat(join(dir, "out-ok", "user", "trace.zip"))).size > 0);
  });

  it("still runs the other roles when one cannot log in, and exits 2", async () => {
    const { code, stdout } = await run({
      auth: [role("broken", "${WRONG}"), role("fine", "${FIXTURE_PASS}")],
      report: { dir: "out-mixed" },
    });
    assert.equal(code, 2);
    assert.match(stdout, /\[broken\] role "broken": login did not succeed/);
    assert.match(stdout, /\[fine\] 8 steps/);
    assert.match(stdout, /\nexit 2: run broken did not complete\n$/);
    assert.ok(!stdout.includes("nope-123"));
  });

  it("runs one anonymous role without auth", async () => {
    const { code, stdout } = await run({ report: { dir: "out-anon" } });
    assert.equal(code, 1);
    assert.match(stdout, /\[anonymous\] 8 steps/);
  });

  it("exits 0 when nothing is found", async () => {
    const { code, stdout } = await run({ limits: { maxSteps: 2 }, report: { dir: "out-clean" } });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /\[anonymous\] 2 steps .*, 0 findings\n/);
    assert.match(
      stdout,
      /\nfindings: 0\ncoverage: \d+ pages visited, \d+ linked pages never visited\nreport: .*report\.html\nexit 0: no findings\n$/,
    );
  });

  it("uses safe directory names for roles", () => {
    assert.equal(roleDirectory("admin"), "admin");
    assert.equal(roleDirectory("../evil role"), ".._evil_role");
    assert.equal(roleDirectory(""), "_");
  });
});

describe("closing a run's session", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-close-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** The shared browser, with `patch` applied to every context it creates. */
  function patched(patch: (context: BrowserContext) => void): { browser: Browser; created: BrowserContext[] } {
    const created: BrowserContext[] = [];
    const wrapper = {
      newContext: async (contextOptions: BrowserContextOptions) => {
        const context = await browser.newContext(contextOptions);
        patch(context);
        created.push(context);
        return context;
      },
    } as Browser;
    return { browser: wrapper, created };
  }

  const loaded = () => parseConfig(JSON.stringify({ baseUrl: site.url, seed: 4, limits: { maxSteps: 8 } }), {});
  const options = (outputDir: string, log: (line: string) => void = () => {}) => ({
    log,
    outputDir,
    actionLog: true,
    artifacts: false,
  });

  it("keeps the findings of a run whose session fails to close, and logs why", async () => {
    const { browser: crashing, created } = patched((context) => {
      const close = context.close.bind(context);
      context.close = async () => {
        await close();
        throw new Error("Target page, context or browser has been closed");
      };
    });
    const lines: string[] = [];
    const outputDir = join(dir, "close-fails");
    const outcome = await runRole(
      crashing,
      undefined,
      loaded(),
      options(outputDir, (line) => lines.push(line)),
    );
    // Seed 4 follows the broken link within 8 steps.
    assert.equal(outcome.result?.stopReason, "maxSteps");
    assert.equal(outcome.findings.length, 1, lines.join("\n"));
    assert.equal(outcome.actionLog, join(outputDir, "actions.json"));
    assert.ok(
      lines.includes(
        "[anonymous] closing the session failed, trace and videos may be missing: Target page, context or browser has been closed",
      ),
    );
    assert.equal(created.length, 1);
    assert.equal(browser.contexts().includes(created[0] as BrowserContext), false);
    await assert.rejects(stat(join(outputDir, "downloads")), { code: "ENOENT" });
  });

  it("closes the session when the action log cannot be created", async () => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "");
    const { browser: tracked, created } = patched(() => {});
    await assert.rejects(runRole(tracked, undefined, loaded(), options(join(blocker, "run"))), /ENOTDIR|EEXIST/);
    assert.equal(created.length, 1);
    assert.equal(browser.contexts().includes(created[0] as BrowserContext), false);
  });
});
