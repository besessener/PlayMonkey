import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../auth/browser.ts";
import { runRole } from "../run.ts";
import { ddmin } from "./ddmin.ts";
import type { ActionLog, LoggedAction, LoggedFinding } from "./log.ts";
import { type PreparedReplay, prepareReplay, ReplayError, toPlanned } from "./replay.ts";

export interface ShrinkOptions {
  /** Config file for login, browser and oracle settings; needed to shrink a log of a role that logs in. */
  config?: string;
  env: NodeJS.ProcessEnv;
  /** Only this finding (`F2`); default: every finding of the log. */
  finding?: string;
  /** Replays per finding, the first check included. */
  maxReplays: number;
  log: (line: string) => void;
  signal?: AbortSignal;
}

/** The outcome for one finding of the log. */
export interface ShrunkFinding {
  /** Masked. */
  finding: LoggedFinding;
  /** Actions up to and including the finding's step. */
  before: number;
  /** Actions of the shortest replay that still reproduces it; absent when even the full one did not. */
  after?: number;
  replays: number;
  /** The replay budget or Ctrl+C ended the search before no single action could be dropped any more. */
  stoppedEarly: boolean;
  /** The shortened action log, `shrink/<id>.actions.json` next to the input; absent when not reproduced. */
  file?: string;
}

/**
 * Shortens the way to each finding of an action log: replays ever smaller subsequences of the actions up to the
 * finding (delta debugging, in a fresh context each, without an LLM, trace or video) and keeps the shortest one in
 * which the oracles still report the finding's dedup key. Writes it as an action log that `monkey replay` can run.
 */
export async function shrinkActionLog(file: string, options: ShrinkOptions): Promise<ShrunkFinding[]> {
  const prepared = await prepareReplay(file, options);
  const targets = chooseTargets(prepared.log.findings, options.finding);
  // Unresolved, so the shortened logs keep their placeholders instead of secret values.
  const raw = JSON.parse(await readFile(file, "utf8")) as ActionLog;
  const outDir = join(dirname(file), "shrink");
  const browser = await launchBrowser(prepared.loaded.config.browser);
  const shrinker = new Shrinker({ prepared, raw, browser, outDir, options });
  const results: ShrunkFinding[] = [];
  try {
    for (const finding of targets) {
      if (options.signal?.aborted === true) break;
      results.push(await shrinker.shrink(finding));
    }
  } finally {
    await browser.close();
    await rm(join(outDir, "work"), { recursive: true, force: true });
  }
  return results;
}

function chooseTargets(findings: LoggedFinding[], id: string | undefined): LoggedFinding[] {
  if (findings.length === 0) throw new ReplayError("the log has no findings to shrink");
  if (id === undefined) return findings;
  const chosen = findings.filter((finding) => finding.id === id);
  if (chosen.length === 0) {
    throw new ReplayError(`no finding ${id} in the log; it has ${findings.map((finding) => finding.id).join(", ")}`);
  }
  return chosen;
}

interface ShrinkerParts {
  prepared: PreparedReplay;
  raw: ActionLog;
  browser: Browser;
  outDir: string;
  options: ShrinkOptions;
}

class Shrinker {
  readonly #parts: ShrinkerParts;
  #replays = 0;

  constructor(parts: ShrinkerParts) {
    this.#parts = parts;
  }

  async shrink(recorded: LoggedFinding): Promise<ShrunkFinding> {
    const { prepared, options } = this.#parts;
    const { secrets } = prepared.loaded;
    const finding = { ...recorded, key: secrets.mask(recorded.key), message: secrets.mask(recorded.message) };
    const all = prepared.log.actions.flatMap((action, index) => (action.step <= recorded.step ? [index] : []));
    options.log(`${finding.id} ${finding.oracle}: ${finding.message}`);
    // Where the finding showed up in each replay that reproduced it, by subsequence.
    const steps = new Map<string, number>();
    const start = this.#replays;
    const test = async (subset: number[]) => {
      const step = await this.#replay(subset, finding.key);
      if (step !== undefined) steps.set(subset.join(","), step);
      return step !== undefined;
    };
    if (!(await test(all))) {
      options.log(`  not reproduced with all ${all.length} actions; nothing to shrink`);
      return { finding, before: all.length, replays: this.#replays - start, stoppedEarly: false };
    }
    const result = await ddmin(all, test, {
      maxTests: options.maxReplays - 1,
      stop: () => options.signal?.aborted === true,
    });
    const file = await this.#write(recorded, result.items, steps.get(result.items.join(",")) ?? result.items.length);
    options.log(`  ${all.length} -> ${result.items.length} actions: ${file}`);
    return {
      finding,
      before: all.length,
      after: result.items.length,
      replays: this.#replays - start,
      stoppedEarly: result.stoppedEarly,
      file,
    };
  }

  /** Replays the actions at `indexes`; the step at which the key was found, or undefined. */
  async #replay(indexes: number[], key: string): Promise<number | undefined> {
    const { prepared, browser, outDir, options } = this.#parts;
    this.#replays++;
    const outcome = await runRole(browser, prepared.role, prepared.loaded, {
      // Each replay's own summary would bury the one line per replay below.
      log: () => undefined,
      outputDir: join(outDir, "work", String(this.#replays)),
      actionLog: false,
      artifacts: false,
      replay: {
        strict: false,
        actions: indexes.map((index) => toPlanned(prepared.log.actions[index] as LoggedAction)),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const step = outcome.findings.find((finding) => finding.key === key)?.step;
    options.log(`  replay ${this.#replays}: ${indexes.length} actions, ${step === undefined ? "gone" : "reproduced"}`);
    return step;
  }

  /** Writes the shortened log, numbered from 1 again, with only this finding. */
  async #write(finding: LoggedFinding, indexes: number[], step: number): Promise<string> {
    const { raw, outDir } = this.#parts;
    const original = raw.findings.find((entry) => entry.id === finding.id) ?? finding;
    const log: ActionLog = {
      ...raw,
      actions: indexes.map((index, position) => ({ ...(raw.actions[index] as LoggedAction), step: position + 1 })),
      findings: [{ ...original, step }],
    };
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `${finding.id}.actions.json`);
    await writeFile(file, `${JSON.stringify(log, null, 2)}\n`);
    return file;
  }
}
