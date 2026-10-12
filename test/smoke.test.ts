import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

  it("builds an executable bin, so `npx monkey` works as in the CI example", {
    skip: process.platform === "win32",
  }, () => {
    // tsc writes files without the executable bit; `npm run build` sets it.
    assert.equal(statSync(join(root, pkg.bin.monkey)).mode & 0o111, 0o111);
    const result = spawnSync("npx", ["--no-install", "monkey", "--version"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
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
