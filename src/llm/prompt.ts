import type { DecideInput } from "./provider.ts";

/**
 * Stable across every call of a run, so providers with prompt caching can cache it together with the tool
 * definitions. Everything that changes per step goes into the user message.
 */
export const SYSTEM_PROMPT = `You are an exploratory tester looking for bugs in a website running in a disposable test environment.
The environment is reset after the run: destructive actions (deleting, submitting, logging out) are fine.

A random monkey drives the browser and hands control to you when it is stuck: a dialog or banner blocks the page,
a form keeps rejecting its input, the session expired, or it stopped finding new pages. Your job is to get past the
obstacle and lead the exploration somewhere new.

Guidelines:
- Prefer areas and features not visited yet, and inputs that are valid enough to get through validation.
- Also try unusual but plausible inputs (long text, special characters, boundary numbers) where they make sense.
- Elements are addressed by their ref (e.g. e12) from the current snapshot only; refs change after every action.
- Never type secrets yourself. Use the listed placeholders, e.g. {{testData.email}} or {{role.password}}; they are
  replaced with the real values after your answer. {{env.NAME}} in the page stands for a hidden value.
- Native browser dialogs (alert, confirm, prompt) and file choosers are answered automatically; you only see the
  page. A click on a file input uploads a generated file. Downloads are saved automatically.
- Call done when the obstacle is gone or nothing sensible is left to do on this page.

Respond with exactly one tool call and no other text.`;

/** The per-step user message: role, goal, placeholders, history, findings and the snapshot last. */
export function buildUserMessage(input: DecideInput): string {
  const lines = [`Role: ${input.role}`, `Why you were called: ${input.goal}`, ""];
  lines.push(
    input.placeholders.length === 0 ? "Placeholders: none" : `Placeholders for values: ${input.placeholders.join(" ")}`,
  );
  if (input.testDataKeys.length > 0) lines.push(`Test data keys: ${input.testDataKeys.join(", ")}`);
  lines.push("");
  if (input.history.length === 0) lines.push("Recent actions: none");
  else {
    lines.push("Recent actions (oldest first):");
    for (const entry of input.history) {
      const outcome = entry.ok ? "ok" : `failed: ${entry.error ?? "unknown error"}`;
      lines.push(`${entry.step}. [${entry.source}] ${entry.action} on ${entry.url} -> ${outcome}`);
    }
  }
  lines.push("");
  if (input.findingsSoFar.length === 0) lines.push("Findings so far: none");
  else lines.push(`Findings so far (${input.findingsSoFar.length}):`, ...input.findingsSoFar.map((f) => `- ${f}`));
  lines.push("", "Current page:", input.snapshot, "", "Choose the next action: exactly one tool call.");
  return lines.join("\n");
}

/** The preflight probe: asks for one specific tool call. */
export function pingMessage(value: string): string {
  return `Connectivity check. Call the ping tool with value "${value}". Respond with exactly one tool call and no other text.`;
}
