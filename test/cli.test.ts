import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCli } from "../src/cli/cli.ts";
import { ExitCode } from "../src/exit-codes.ts";

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("runCli", () => {
  it("prints usage for run and replay with --help", async () => {
    const { code, stdout } = await cli("--help");
    assert.equal(code, ExitCode.NoFindings);
    assert.match(stdout, /run <config\.json>/);
    assert.match(stdout, /replay <actions\.json>/);
  });

  it("prints the package version with --version", async () => {
    const { code, stdout } = await cli("--version");
    assert.equal(code, ExitCode.NoFindings);
    assert.match(stdout, /^\d+\.\d+\.\d+/);
  });

  it("exits 2 without a command", async () => {
    const { code, stderr } = await cli();
    assert.equal(code, ExitCode.Error);
    assert.match(stderr, /missing command/);
  });

  it("exits 2 on an unknown command", async () => {
    const { code, stderr } = await cli("explode");
    assert.equal(code, ExitCode.Error);
    assert.match(stderr, /unknown command 'explode'/);
  });

  it("exits 2 on an unknown option", async () => {
    const { code } = await cli("run", "config.json", "--nope");
    assert.equal(code, ExitCode.Error);
  });

  for (const command of ["run", "replay"]) {
    it(`exits 2 when ${command} has no file argument`, async () => {
      const { code, stderr } = await cli(command);
      assert.equal(code, ExitCode.Error);
      assert.match(stderr, /expected exactly one/);
    });
  }
});

describe("ExitCode", () => {
  it("has the documented values", () => {
    assert.deepEqual(ExitCode, { NoFindings: 0, Findings: 1, Error: 2 });
  });
});
