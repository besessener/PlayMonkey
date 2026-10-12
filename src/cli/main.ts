#!/usr/bin/env node
import { ExitCode } from "../exit-codes.ts";
import { runCli } from "./cli.ts";

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  process.stderr.write(`monkey: unexpected error: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = ExitCode.Error;
}
