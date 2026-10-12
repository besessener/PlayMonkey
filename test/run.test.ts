import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { roleDirectory } from "../src/run.ts";

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
    await writeFile(file, JSON.stringify({ baseUrl: site.url, seed: 7, limits: { maxSteps: 8 }, ...config }));
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
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^seed: 7\n/);
    assert.match(stdout, /\[user\] 8 steps in [\d.]+s, \d+ states, \d+ failed actions, stopped: maxSteps/);
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
    assert.ok(!stdout.includes("nope-123"));
  });

  it("runs one anonymous role without auth", async () => {
    const { code, stdout } = await run({ report: { dir: "out-anon" } });
    assert.equal(code, 0);
    assert.match(stdout, /\[anonymous\] 8 steps/);
  });

  it("uses safe directory names for roles", () => {
    assert.equal(roleDirectory("admin"), "admin");
    assert.equal(roleDirectory("../evil role"), ".._evil_role");
    assert.equal(roleDirectory(""), "_");
  });
});
