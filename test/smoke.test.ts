import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the built CLI (`npm test` builds first via `pretest`) through the path declared in `bin`.
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bin: { monkey: string };
};

function monkey(...args: string[]) {
  const result = spawnSync(process.execPath, [pkg.bin.monkey, ...args], { cwd: root, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("built monkey CLI", () => {
  it("--help exits 0 and lists run and replay", () => {
    const { code, stdout } = monkey("--help");
    assert.equal(code, 0);
    assert.match(stdout, /run <config\.json>/);
    assert.match(stdout, /replay <actions\.json>/);
  });

  it("unknown subcommand exits 2", () => {
    assert.equal(monkey("bogus").code, 2);
  });

  it("missing subcommand exits 2", () => {
    assert.equal(monkey().code, 2);
  });

  it("run with a missing config and replay with a missing log exit 2", () => {
    assert.equal(monkey("run", "missing-config.json").code, 2);
    const replay = monkey("replay", "missing-actions.json");
    assert.equal(replay.code, 2);
    assert.match(replay.stderr, /action log missing-actions\.json: cannot read file \(ENOENT\)/);
  });
});
