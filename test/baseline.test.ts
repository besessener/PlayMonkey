import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { parseConfig } from "../src/config/config.ts";
import { BaselineError, compareBaseline, readBaseline, toBaseline } from "../src/report/baseline.ts";
import { renderHtml } from "../src/report/html.ts";
import { type AggregatedFinding, buildReport } from "../src/report/report.ts";

const group = (key: string, severity: AggregatedFinding["severity"] = "medium"): AggregatedFinding => ({
  key,
  oracle: "console",
  severity,
  message: `message ${key}`,
  url: "https://test.example.org/",
  occurrences: 1,
  roles: ["user"],
  runs: [{ role: "user", seed: 1, id: "F1" }],
});

describe("baseline files", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "monkey-baseline-"));
  });

  const write = async (name: string, content: string) => {
    const file = join(dir, name);
    await writeFile(file, content);
    return file;
  };
  const reason = async (file: string) => {
    try {
      await readBaseline(file);
    } catch (error) {
      assert.ok(error instanceof BaselineError, String(error));
      return error.message;
    }
    assert.fail("expected a BaselineError");
  };

  it("keeps only what identifies a finding, sorted by key", () => {
    assert.deepEqual(toBaseline([group("console|b", "low"), group("console|a")]), {
      version: 1,
      findings: [
        { key: "console|a", oracle: "console", severity: "medium", message: "message console|a" },
        { key: "console|b", oracle: "console", severity: "low", message: "message console|b" },
      ],
    });
  });

  it("reads a baseline back and rejects broken ones with a clear message", async () => {
    const good = await write("good.json", JSON.stringify(toBaseline([group("console|a")])));
    assert.equal((await readBaseline(good)).findings[0]?.key, "console|a");
    assert.match(await reason(join(dir, "missing.json")), /cannot read file \(ENOENT\); write one by copying/);
    assert.match(await reason(await write("bad.json", "{")), /invalid JSON/);
    assert.match(await reason(await write("v2.json", '{"version":2}')), /unsupported version 2; expected 1/);
    assert.match(await reason(await write("null.json", "null")), /unsupported version undefined/);
    const noKeys = await write("keys.json", '{"version":1,"findings":[{"oracle":"console"}]}');
    assert.match(await reason(noKeys), /findings must be a list of entries with a key/);
  });

  it("marks findings known or new and lists the baseline's findings this run did not see", () => {
    const baseline = toBaseline([group("console|a"), group("console|gone")]);
    const { findings, comparison } = compareBaseline([group("console|a"), group("console|b")], baseline, "base.json");
    assert.deepEqual(
      findings.map((f) => [f.key, f.known]),
      [
        ["console|a", true],
        ["console|b", false],
      ],
    );
    assert.deepEqual(comparison, {
      file: "base.json",
      known: 1,
      new: 1,
      unseen: [{ key: "console|gone", oracle: "console", severity: "medium", message: "message console|gone" }],
    });
  });

  it("shows known findings and the unseen ones in the HTML report", () => {
    const loaded = parseConfig(
      JSON.stringify({ baseUrl: "https://test.example.org", seed: 1, findings: { baseline: "base.json" } }),
      { baseDir: dir },
    );
    const finding = {
      id: "F1",
      oracle: "console" as const,
      severity: "medium" as const,
      key: "console|a",
      message: "message console|a",
      url: "https://test.example.org/",
      step: 1,
      role: "anonymous",
      occurrences: 1,
      details: {},
      lastActions: [],
    };
    const report = buildReport({
      loaded,
      outcomes: [{ role: "anonymous", seed: 1, findings: [finding], blockedNavigations: 0 }],
      version: "1.0.0",
      startedAt: new Date(0),
      finishedAt: new Date(0),
      baseline: toBaseline([group("console|a"), group("console|<b>gone</b>")]),
    });
    assert.equal(report.baseline?.file, "../base.json");
    assert.equal(report.aggregated[0]?.known, true);
    const html = renderHtml(report, new Map());
    assert.match(html, /Baseline <code>\.\.\/base\.json<\/code>: 0 new, 1 known/);
    assert.match(html, /title="Listed in the baseline">known</);
    assert.match(html, /Not seen this time[\s\S]*message console\|&lt;b&gt;gone&lt;\/b&gt;/);
  });
});

describe("monkey run with findings.baseline", () => {
  let site: Fixture;
  let dir: string;
  before(async () => {
    site = await startFixture();
    dir = await mkdtemp(join(tmpdir(), "monkey-baseline-run-"));
  });
  after(() => site?.close());

  async function run(name: string, extra: Record<string, unknown> = {}) {
    const file = join(dir, `${name}.json`);
    // Seed 4 follows the broken link within 8 steps: one finding.
    const config = { baseUrl: site.url, seed: 4, limits: { maxSteps: 8 }, report: { dir: name }, ...extra };
    await writeFile(file, JSON.stringify(config));
    let stdout = "";
    let stderr = "";
    const code = await runCli(["run", file], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: {},
    });
    return { code, stdout, stderr };
  }

  it("writes baseline.json, and a run with it as baseline passes while its findings recur", async () => {
    const first = await run("first");
    assert.equal(first.code, 1, first.stdout);
    const written = JSON.parse(await readFile(join(dir, "first", "baseline.json"), "utf8"));
    assert.deepEqual(
      written.findings.map((f: { key: string }) => f.key),
      ["http4xx|GET /missing-page 404"],
    );

    const second = await run("second", { findings: { baseline: "first/baseline.json" } });
    assert.equal(second.code, 0, second.stdout);
    assert.match(second.stdout, /\nbaseline: 0 new, 1 known, 0 not seen this time\n/);
    assert.match(second.stdout, /\nexit 0: no new findings\n$/);
  });

  it("fails on new findings and lists what it did not see", async () => {
    await writeFile(
      join(dir, "other.json"),
      JSON.stringify({
        version: 1,
        findings: [{ key: "console|old", oracle: "console", severity: "low", message: "old" }],
      }),
    );
    const { code, stdout } = await run("third", { findings: { baseline: "other.json" } });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\nbaseline: 1 new, 0 known, 1 not seen this time\n/);
    assert.match(stdout, /\nexit 1: new findings present\n$/);
  });

  it("stops before the browser when the baseline cannot be read", async () => {
    const { code, stdout, stderr } = await run("fourth", { findings: { baseline: "nope.json" } });
    assert.equal(code, 2);
    assert.match(stderr, /^monkey run: baseline .*nope\.json: cannot read file \(ENOENT\)/);
    assert.doesNotMatch(stdout, /starting/);
  });
});
