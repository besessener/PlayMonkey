import { maskSecrets, type Secrets } from "./config/secrets.ts";
import { type Action, describeAction, mapActionText } from "./monkey/actions.ts";
import { describeEvent } from "./monkey/events.ts";
import type { RunResult, StepRecord } from "./monkey/loop.ts";
import type { Finding } from "./oracles/finding.ts";

/**
 * One masked line per step in spectator mode, e.g. `step 12 llm: click getByRole('link', { name: 'Home' }) -> failed: …`.
 */
export function describeStep(record: StepRecord, secrets: Secrets): string {
  const { locator } = record;
  // Masked before describeAction shortens the value, which could cut a secret in half.
  const action = mapActionText(record.action, (value) => secrets.mask(value));
  // The durable locator says more than the short-lived ref.
  const text = describeAction(
    locator === undefined || !("ref" in action) ? action : ({ ...action, ref: locator } as Action),
  );
  const outcome = record.result.ok ? "" : ` -> failed: ${record.result.error ?? "unknown error"}`;
  const events = record.events === undefined ? "" : ` [${record.events.map(describeEvent).join("; ")}]`;
  return secrets.mask(`step ${record.step} ${record.source}: ${text}${outcome}${events}`);
}

/** The summary line of a finished run, e.g. `300 steps in 81.2s, 40 states, 3 failed actions, stopped: maxSteps`. */
export function summarize(result: RunResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const stop = result.stopReason === "error" ? `error: ${result.error}` : result.stopReason;
  const skipped = result.skippedActions > 0 ? `, ${result.skippedActions} skipped` : "";
  return `${result.steps} steps in ${seconds}s, ${result.states} states, ${result.failedActions} failed actions${skipped}, stopped: ${stop}`;
}

/**
 * Masks everything a page could have echoed. The key was masked before deduplication and the role is no secret, so
 * neither changes here; the screenshot path is a local file path, like the trace path.
 */
export function maskFinding(finding: Finding, secrets: Secrets): Finding {
  const { screenshotPath, key, role, ...rest } = finding;
  return { ...maskSecrets(rest, secrets), key, role, ...(screenshotPath === undefined ? {} : { screenshotPath }) };
}

/** One line per finding, e.g. `F1 high pageerror: Error: boom (step 12, 3×)`. */
export function describeFinding(finding: Finding): string {
  const times = finding.occurrences > 1 ? `, ${finding.occurrences}×` : "";
  return `${finding.id} ${finding.severity} ${finding.oracle}: ${finding.message} (step ${finding.step}${times})`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
