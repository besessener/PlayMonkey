import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { withStopSignal } from "../src/cli/common.ts";
import { parseConfig } from "../src/config/config.ts";
import { ExitCode } from "../src/exit-codes.ts";
import { runAllRoles } from "../src/run.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

describe("withStopSignal", () => {
  it("aborts on the first stop signal and exits with 128 + signal number on the second", async () => {
    let stderr = "";
    const exits: number[] = [];
    const io = {
      stdout: () => {},
      stderr: (text: string) => (stderr += text),
      exit: (status: number) => exits.push(status),
    };
    const code = await withStopSignal("run", io, (signal) => {
      process.emit("SIGTERM", "SIGTERM");
      assert.ok(signal.aborted);
      assert.deepEqual(exits, []);
      process.emit("SIGINT", "SIGINT");
      return Promise.resolve(ExitCode.Error);
    });
    assert.equal(code, ExitCode.Error);
    assert.deepEqual(exits, [130]);
    assert.match(stderr, /^monkey run: SIGTERM: stopping after the current step/);
    assert.match(stderr, /monkey run: SIGINT again: exiting without waiting for the current step\n$/);
    assert.equal(process.listenerCount("SIGHUP"), 0);
  });
});

describe("interrupting a run", () => {
  let site: Fixture;
  let dir: string;
  before(async () => {
    site = await startFixture();
    dir = await mkdtemp(join(tmpdir(), "monkey-interrupt-"));
  });
  after(() => site?.close());

  async function writeConfig(name: string, config: Record<string, unknown>): Promise<string> {
    const file = join(dir, `${name}.json`);
    await writeFile(file, JSON.stringify({ baseUrl: site.url, report: { dir: join(dir, name) }, ...config }));
    return file;
  }

  it("records runs the signal kept from starting as not started", async () => {
    const file = await writeConfig("unstarted", { seeds: [1, 2] });
    const loaded = parseConfig(await readFile(file, "utf8"), { env: {}, baseDir: dir });
    const lines: string[] = [];
    const outcomes = await runAllRoles(loaded, { log: (line) => lines.push(line), signal: AbortSignal.abort() });
    assert.deepEqual(
      outcomes.map(({ role, seed, error, result, findings }) => ({ role, seed, error, result, findings })),
      [1, 2].map((seed) => ({
        role: "anonymous",
        seed,
        error: "not started: interrupted",
        result: undefined,
        findings: [],
      })),
    );
    assert.deepEqual(lines, ["[anonymous/1] not started: interrupted", "[anonymous/2] not started: interrupted"]);
  });

  it("stops on SIGINT, writes the findings so far into the report and exits 2", async () => {
    // Seed 4 follows the broken link within 8 steps; the limits are far away.
    const file = await writeConfig("sigint", { seed: 4, limits: { maxSteps: 10_000, maxMinutes: 5 } });
    const child = spawn(process.execPath, [MAIN, "run", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
    await waitForActions(join(dir, "sigint", "anonymous", "actions.json"), 10);
    child.kill("SIGINT");
    const code = await exited;

    assert.equal(code, ExitCode.Error, `${stdout}\n${stderr}`);
    assert.match(stderr, /monkey run: SIGINT: stopping after the current step/);
    assert.match(stdout, /\[anonymous\] \d+ steps in [\d.]+s, .*stopped: aborted, [1-9]\d* findings?\n/);
    assert.match(stdout, /\nexit 2: run anonymous did not complete\n$/);
    const report = JSON.parse(await readFile(join(dir, "sigint", "report.json"), "utf8"));
    assert.equal(report.roles[0].stopReason, "aborted");
    assert.ok(report.roles[0].findings > 0);
    assert.ok(
      report.findings.some((finding: { message: string }) => /GET \/missing-page responded 404/.test(finding.message)),
      JSON.stringify(report.findings),
    );
  });
});

/** Waits until the action log of a running run holds at least `count` actions. */
async function waitForActions(file: string, count: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      // Rewritten atomically after every step, so it is always complete JSON.
      if (JSON.parse(await readFile(file, "utf8")).actions.length >= count) return;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fewer than ${count} actions in ${file} after 60 s`);
}
