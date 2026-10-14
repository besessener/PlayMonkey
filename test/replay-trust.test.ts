import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { runCli } from "../src/cli/cli.ts";
import { ExitCode } from "../src/exit-codes.ts";
import { ActionLogError } from "../src/replay/log.ts";
import { prepareReplay } from "../src/replay/replay.ts";

// Never contacted: every log here is refused, or only prepared, before a browser starts.
const SITE = "http://site.invalid";
const TOKEN = "tok-3141-secret";
const ENV = { SITE_URL: SITE, HOME_TOKEN: TOKEN };

describe("replaying an untrusted action log", () => {
  let dir: string;
  let siteConfig: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "playmonkey-trust-"));
    siteConfig = await write("site.json", { baseUrl: "${SITE_URL}" });
  });

  async function write(name: string, content: unknown): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, JSON.stringify(content));
    return file;
  }

  const action = (step: number, fields: Record<string, unknown>) => ({
    step,
    source: "monkey",
    pageUrl: "${SITE_URL}/",
    snapshotHash: "h",
    ok: true,
    ...fields,
  });

  /** A log of an anonymous run on the site, with `overrides`. */
  function log(overrides: Record<string, unknown> = {}) {
    return {
      version: 3,
      seed: 1,
      baseUrl: "${SITE_URL}",
      role: "anonymous",
      viewport: [800, 600],
      placeholders: ["HOME_TOKEN", "SITE_URL"],
      actions: [action(1, { type: "fill", ref: "e1", value: "${HOME_TOKEN}", locator: "getByRole('textbox')" })],
      findings: [{ id: "F1", oracle: "console", severity: "medium", key: "console|x", message: "x", step: 1 }],
      ...overrides,
    };
  }

  async function cli(args: string[]) {
    let stderr = "";
    const code = await runCli(args, {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      env: ENV,
    });
    return { code, stderr };
  }

  it("fills in only variables that the config uses, never one the log picks", async () => {
    const file = await write("token.actions.json", log());
    await assert.rejects(
      prepareReplay(file, { config: siteConfig, env: ENV }),
      (error: Error) =>
        error instanceof ActionLogError &&
        /needs HOME_TOKEN, but/.test(error.message) &&
        !error.message.includes(TOKEN),
    );

    const both = await write("both.json", { baseUrl: "${SITE_URL}/start", testData: { token: "${HOME_TOKEN}" } });
    const prepared = await prepareReplay(file, { config: both, env: ENV });
    assert.equal(prepared.log.baseUrl, SITE);
    assert.equal((prepared.log.actions[0] as { value: string }).value, TOKEN);
  });

  it("fills in nothing without --config, so a log with placeholders needs one", async () => {
    const file = await write("noconfig.actions.json", log());
    const refused = await cli(["replay", file]);
    assert.equal(refused.code, ExitCode.Error);
    assert.match(refused.stderr, /needs HOME_TOKEN, SITE_URL, but replay fills in only variables that the --config/);

    const literal = await write("literal.actions.json", log({ baseUrl: SITE, placeholders: [] }));
    const prepared = await prepareReplay(literal, { env: ENV });
    assert.equal((prepared.log.actions[0] as { value: string }).value, "${HOME_TOKEN}");
    assert.equal(prepared.loaded.config.baseUrl, SITE);
  });

  it("refuses a log whose baseUrl is on another origin than the config's", async () => {
    for (const baseUrl of ["http://attacker.invalid", "https://site.invalid", "http://site.invalid:8080"]) {
      const file = await write("origin.actions.json", log({ baseUrl, placeholders: ["SITE_URL"], actions: [] }));
      const { code, stderr } = await cli(["replay", "--config", siteConfig, file]);
      assert.equal(code, ExitCode.Error, baseUrl);
      assert.match(
        stderr,
        /baseUrl .* is not on the origin of the config's baseUrl http:\/\/site\.invalid; replay only logs/,
        baseUrl,
      );
    }
  });

  it("refuses a baseUrl that is not http(s), with or without --config", async () => {
    for (const baseUrl of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      const file = await write("scheme.actions.json", log({ baseUrl, placeholders: [], actions: [] }));
      for (const args of [
        ["replay", file],
        ["replay", "--config", siteConfig, file],
        ["shrink", file],
      ]) {
        const { code, stderr } = await cli(args);
        assert.equal(code, ExitCode.Error, `${args.join(" ")}: ${baseUrl}`);
        assert.match(stderr, /is not an http\(s\) URL/, `${args.join(" ")}: ${baseUrl}`);
      }
    }
  });

  it("refuses navigate actions that leave the site, its scope or http(s), naming the step", async () => {
    const offSite = await write("offsite.json", { baseUrl: "${SITE_URL}", stayOnDomain: false });
    const scoped = await write("scoped.json", { baseUrl: "${SITE_URL}", scope: { deny: ["/admin"] } });
    const cases: [string, string, RegExp][] = [
      ["javascript:alert(1)", siteConfig, /step 2: navigate javascript:alert\(1\) is not an http\(s\) URL/],
      ["file:///etc/passwd", offSite, /step 2: navigate file:\/\/\/etc\/passwd is not an http\(s\) URL/],
      ["http://attacker.invalid/x", siteConfig, /step 2: navigate .* leaves the site under test \(stayOnDomain\)/],
      ["${SITE_URL}/admin", scoped, /step 2: navigate http:\/\/site\.invalid\/admin is outside the configured scope/],
    ];
    for (const [url, config, expected] of cases) {
      const actions = [action(1, { type: "back" }), action(2, { type: "navigate", url })];
      const file = await write("navigate.actions.json", log({ placeholders: ["SITE_URL"], actions }));
      const { code, stderr } = await cli(["replay", "--config", config, file]);
      assert.equal(code, ExitCode.Error, url);
      assert.match(stderr, expected, url);
    }

    const allowed = [action(1, { type: "navigate", url: "${SITE_URL}/ok" })];
    const offOrigin = [action(1, { type: "navigate", url: "http://other.invalid/" })];
    const fine = await write("fine.actions.json", log({ placeholders: ["SITE_URL"], actions: allowed }));
    const away = await write("away.actions.json", log({ placeholders: ["SITE_URL"], actions: offOrigin }));
    assert.equal((await prepareReplay(fine, { config: siteConfig, env: ENV })).log.actions.length, 1);
    assert.equal((await prepareReplay(away, { config: offSite, env: ENV })).log.actions.length, 1);
  });

  it("refuses finding ids that are not F1, F2, …, before shrink uses one in a file name", async () => {
    const findings = [{ id: "../escaped", oracle: "console", severity: "low", key: "k", message: "m", step: 1 }];
    const file = await write("id.actions.json", log({ baseUrl: SITE, placeholders: [], findings }));
    for (const command of ["replay", "shrink"]) {
      const { code, stderr } = await cli([command, file]);
      assert.equal(code, ExitCode.Error, command);
      assert.match(stderr, /findings\[0\]: id must look like F1, got "\.\.\/escaped"/, command);
    }
    await assert.rejects(access(join(dir, "escaped.actions.json")), { code: "ENOENT" });
  });
});
