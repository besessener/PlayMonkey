import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { openRoleSession } from "../../src/auth/session.ts";
import { parseConfig } from "../../src/config/config.ts";
import type { Action } from "../../src/monkey/actions.ts";
import { type PlannedAction, type RunOptions, runMonkey, type StepRecord } from "../../src/monkey/loop.ts";
import { Oracles } from "../../src/oracles/oracles.ts";

/** A scripted step: the action and the durable locator(s) it acts on. */
export const step = (action: Action, locator?: string, toLocator?: string): PlannedAction => ({
  action,
  source: "monkey",
  ...(locator === undefined ? {} : { locator }),
  ...(toLocator === undefined ? {} : { toLocator }),
});
export const click = (locator: string) => step({ type: "click", ref: "x" }, locator);
export const button = (name: string) => `getByRole('button', { name: '${name}' })`;
export const link = (name: string) => `getByRole('link', { name: '${name}' })`;

export interface DriveOptions {
  browser: Browser;
  baseUrl: string;
  /** Parent directory of the run's output directory. */
  dir: string;
  /** Scripted actions, run as a strict replay plan; without them, the random monkey runs. */
  actions?: PlannedAction[];
  /** Config keys besides `baseUrl`, `seed` 1 and `monkey.actionTimeoutMs` 2000. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
  advisor?: RunOptions["advisor"];
}

/**
 * Runs through the real loop with the stayOnDomain guard, the page events and the oracles. The context stays open for
 * assertions; close it with `done`.
 */
export async function drive({ browser, baseUrl, dir, actions, extra = {}, signal, advisor }: DriveOptions) {
  const { config, secrets } = parseConfig(
    JSON.stringify({ baseUrl, seed: 1, monkey: { actionTimeoutMs: 2000 }, ...extra }),
  );
  const outputDir = await mkdtemp(join(dir, "drive-"));
  const session = await openRoleSession(browser, undefined, { config, secrets, outputDir, trace: false, video: false });
  const oracles = new Oracles(session.context, { config, role: "anonymous", screenshotDir: join(outputDir, "shots") });
  const records: StepRecord[] = [];
  const downloadDir = join(outputDir, "downloads");
  const result = await runMonkey(session.context, {
    config,
    downloadDir,
    ...(actions === undefined ? {} : { replay: { strict: true, actions } }),
    ...(signal === undefined ? {} : { signal }),
    ...(advisor === undefined ? {} : { advisor }),
    onStep: async (record) => {
      records.push(record);
      const pages = session.context.pages();
      await oracles.check(record, pages[record.result.tab] ?? pages[0]);
    },
  });
  const findings = await oracles.finish();
  const events = records.flatMap((record) => record.events ?? []);
  return { result, records, findings, events, context: session.context, downloadDir, done: () => session.close() };
}
