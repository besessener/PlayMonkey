import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { parseConfig } from "../src/config/config.ts";
import type { ActionLog } from "../src/replay/log.ts";
import type { Report } from "../src/report/report.ts";
import { planRuns } from "../src/run-plan.ts";

const SEEDS = [3, 4, 5];

describe("parallel runs per role and seed", () => {
  let site: Fixture;
  let dir: string;
  before(async () => {
    site = await startFixture();
    dir = await mkdtemp(join(tmpdir(), "monkey-parallel-"));
  });
  after(() => site?.close());

  const role = (name: string, password = "${FIXTURE_PASS}") => ({
    name,
    loginUrl: "/login",
    fields: { username: "${FIXTURE_USER}", password },
    submit: "button[type=submit]",
  });

  async function run(name: string, config: Record<string, unknown>) {
    const file = join(dir, `${name}.json`);
    await writeFile(
      file,
      JSON.stringify({ baseUrl: site.url, limits: { maxSteps: 8 }, report: { dir: name }, ...config }),
    );
    let stdout = "";
    const code = await runCli(["run", file], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stdout += text;
      },
      env: { FIXTURE_USER: FIXTURE_CREDENTIALS.username, FIXTURE_PASS: FIXTURE_CREDENTIALS.password, WRONG: "nope-9" },
    });
    const report = JSON.parse(await readFile(join(dir, name, "report.json"), "utf8")) as Report;
    return { code, stdout, report, dir: join(dir, name) };
  }

  /** The action sequence of a run, without timing-dependent outcomes. */
  async function actions(file: string) {
    const log = JSON.parse(await readFile(file, "utf8")) as ActionLog;
    return { seed: log.seed, actions: log.actions.map(({ ok, error, events, ...action }) => action) };
  }

  it("runs 2 roles × 3 seeds at parallel 3 into 6 run directories and one combined report", async () => {
    const parallel = await run("p3", { auth: [role("admin"), role("user")], seeds: SEEDS, parallel: 3 });
    assert.match(parallel.stdout, /^seeds: 3, 4, 5\nruns: 6, 3 at a time\n/);
    assert.match(parallel.stdout, /\[admin\/4\] 8 steps/);
    for (const name of ["admin", "user"]) {
      for (const seed of SEEDS) {
        assert.ok(existsSync(join(parallel.dir, name, String(seed), "actions.json")), `${name}/${seed}`);
        assert.ok(existsSync(join(parallel.dir, name, String(seed), "trace.zip")), `${name}/${seed}`);
      }
    }
    const { report } = parallel;
    // Config order, whatever order the runs finished in.
    assert.deepEqual(
      report.roles.map((r) => `${r.role}/${r.seed}`),
      ["admin/3", "admin/4", "admin/5", "user/3", "user/4", "user/5"],
    );
    assert.deepEqual(report.seeds, SEEDS);
    assert.equal(report.roles[1]?.actionLog, "admin/4/actions.json");
    // Seed 4 follows the broken link within 8 steps, in both roles: one aggregated finding found in both.
    const broken = report.aggregated.find((f) => f.message === "GET /missing-page responded 404 Not Found");
    assert.ok(broken !== undefined, JSON.stringify(report.aggregated));
    assert.deepEqual(broken.roles, ["admin", "user"]);
    assert.ok(broken.runs.some((r) => r.role === "admin" && r.seed === 4));
    assert.ok(broken.runs.some((r) => r.role === "user" && r.seed === 4));
    assert.equal(report.counts.medium, report.aggregated.filter((f) => f.severity === "medium").length);
    assert.equal(parallel.code, 1, parallel.stdout);
    const html = await readFile(join(parallel.dir, "report.html"), "utf8");
    assert.match(html, /<dt>Found in<\/dt><dd>admin, user · /);

    // Monkey-only runs take the same actions as when they run one after the other.
    const sequential = await run("p1", { auth: [role("admin"), role("user")], seeds: SEEDS, parallel: 1 });
    assert.match(sequential.stdout, /\nruns: 6, 1 at a time\n/);
    for (const name of ["admin", "user"]) {
      for (const seed of SEEDS) {
        const file = (base: string) => join(base, name, String(seed), "actions.json");
        assert.deepEqual(await actions(file(parallel.dir)), await actions(file(sequential.dir)), `${name}/${seed}`);
      }
    }
  });

  it("still runs the other role when one has wrong credentials, and exits 2", async () => {
    const { code, stdout, report } = await run("wrong", {
      auth: [role("broken", "${WRONG}"), role("fine")],
      seeds: [4],
      parallel: 2,
    });
    assert.equal(code, 2, stdout);
    assert.match(stdout, /\[broken\/4\] role "broken": login did not succeed/);
    assert.match(stdout, /\[fine\/4\] 8 steps .*, 1 finding\n/);
    assert.match(stdout, /\nexit 2: run broken\/4 did not complete\n$/);
    assert.ok(!stdout.includes("nope-9"));
    assert.deepEqual(
      report.roles.map((r) => [r.role, r.steps]),
      [
        ["broken", undefined],
        ["fine", 8],
      ],
    );
    assert.equal(report.aggregated.length, 1);
  });

  it("plans runs roles first, then seeds, and keeps the plain layout without seeds", () => {
    const parse = (config: Record<string, unknown>) =>
      parseConfig(JSON.stringify({ baseUrl: "https://test.example.org", ...config }), { baseDir: "/c" }).config;
    const auth = [
      { name: "a", storageState: "a.json" },
      { name: "b c", storageState: "b.json" },
    ];
    assert.deepEqual(
      planRuns(parse({ auth, seeds: [7, 1] })).map((r) => [r.label, r.seed, r.outputDir]),
      [
        ["a/7", 7, resolve("/c/monkey-report/a/7")],
        ["a/1", 1, resolve("/c/monkey-report/a/1")],
        ["b c/7", 7, resolve("/c/monkey-report/b_c/7")],
        ["b c/1", 1, resolve("/c/monkey-report/b_c/1")],
      ],
    );
    assert.deepEqual(
      planRuns(parse({ seed: 9 })).map((r) => [r.label, r.seed, r.outputDir]),
      [["anonymous", 9, resolve("/c/monkey-report/anonymous")]],
    );
  });
});
