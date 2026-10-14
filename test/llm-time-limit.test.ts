import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LlmConfig, parseConfig } from "../src/config/config.ts";
import { LlmBreaker, LlmDriver } from "../src/llm/driver.ts";
import { PromptPlaceholders } from "../src/llm/placeholders.ts";
import { LlmError } from "../src/llm/provider.ts";
import { StuckDetector } from "../src/llm/stuck.ts";
import { LlmStats } from "../src/llm/usage.ts";
import type { Snapshot } from "../src/snapshot/snapshot.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";

const PAGE: Snapshot = {
  url: "https://test.example.org/",
  title: "Home",
  elements: [{ ref: "e1", role: "button", name: "Save", enabled: true, inViewport: true, inFrame: false }],
  text: "Welcome",
  crossOriginFrames: 0,
  dialogs: ["Cookies"],
  hash: "h0",
};

interface Options {
  /** Overrides `llm.timeoutMs` below its config minimum, to keep the tests fast. */
  timeoutMs?: number;
  signal?: AbortSignal;
  deadline?: number;
  maxCalls?: number;
}

/** A driver whose detector always reports a dialog; `choose(n)` asks it for step `n`. */
function setup(script: ConstructorParameters<typeof FakeProvider>[0], options: Options = {}) {
  const { config, secrets } = parseConfig(
    JSON.stringify({
      baseUrl: "https://test.example.org",
      llm: {
        provider: "anthropic-foundry",
        baseUrl: "https://res.services.ai.azure.com/anthropic",
        deployment: "claude",
        apiKey: "${KEY}",
        handoff: { cooldownSteps: 0 },
        breaker: { failures: 3, pauseSteps: 5 },
        ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
      },
    }),
    { env: { KEY: "key-0123456789" } },
  );
  const llm = { ...(config.llm as LlmConfig), timeoutMs: options.timeoutMs ?? 60_000 };
  const provider = new FakeProvider(script);
  const stats = new LlmStats(llm, provider.name);
  const breaker = new LlmBreaker();
  const lines: string[] = [];
  const driver = new LlmDriver({
    provider,
    config: llm,
    stats,
    detector: new StuckDetector(llm.handoff, { authenticated: false }),
    placeholders: new PromptPlaceholders(config, secrets, "admin"),
    role: "anonymous",
    breaker,
    findings: () => [],
    log: (line) => lines.push(line),
    signal: options.signal,
    deadline: options.deadline,
  });
  const choose = (step: number) => {
    driver.observe(PAGE, step === 1);
    return driver.choose(PAGE, step);
  };
  return { provider, stats, breaker, lines, choose };
}

/** Runs `work` and returns its result with the time it took. */
async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started };
}

describe("LLM time limits", () => {
  it("cuts off a provider that never answers after llm.timeoutMs and opens the breaker at once", async () => {
    const { provider, stats, lines, choose } = setup([{ hang: true }], { timeoutMs: 50 });
    const { result, ms } = await timed(() => choose(1));
    assert.equal(result, undefined);
    assert.ok(ms >= 45 && ms < 2000, `took ${ms} ms`);
    // The provider got a signal that aborted, so a real backend cancels its request and retries.
    assert.equal(provider.signals[0]?.aborted, true);
    const total = stats.report().total;
    assert.deepEqual(total.errors, { timeout: 1 });
    assert.deepEqual(total.fallbacks, { timeout: 1 });
    assert.equal(total.breakerTrips, 1);
    assert.ok(
      lines.some((line) => /LLM timeout; pausing the LLM for 5 steps/.test(line)),
      lines.join("\n"),
    );
    for (let step = 2; step <= 6; step++) assert.equal(await choose(step), undefined);
    assert.equal(provider.inputs.length, 1, "paused after the first timeout");
  });

  it("opens the breaker on the first unreachable endpoint, other errors need failures in a row", async () => {
    const unreachable = setup([{ error: new LlmError("unreachable", "connection failed (ECONNREFUSED)") }]);
    await unreachable.choose(1);
    assert.equal(unreachable.breaker.trips, 1);
    const server = setup([1, 2, 3].map(() => ({ error: new LlmError("server", "500 Internal Server Error") })));
    for (let step = 1; step <= 2; step++) await server.choose(step);
    assert.equal(server.breaker.trips, 0);
    await server.choose(3);
    assert.equal(server.breaker.trips, 1);
  });

  it("cancels a decision in flight when the run stops, without counting it against the LLM", async () => {
    const controller = new AbortController();
    const { provider, stats, breaker, lines, choose } = setup([{ hang: true }], {
      signal: controller.signal,
      maxCalls: 1,
    });
    setTimeout(() => controller.abort(), 20);
    const { result, ms } = await timed(() => choose(1));
    assert.equal(result, undefined);
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.equal(provider.signals[0]?.aborted, true);
    const total = stats.report().total;
    assert.equal(total.failedCalls, 0);
    assert.deepEqual(total.fallbacks, {});
    assert.equal(breaker.failures, 0);
    assert.equal(breaker.trips, 0);
    // The reserved call is released: it does not use up llm.maxCalls.
    assert.equal(stats.budgetProblem(), undefined);
    assert.ok(
      lines.some((line) => /the run is stopping; LLM decision cancelled/.test(line)),
      lines.join("\n"),
    );
    // Once stopped, no further call is sent.
    assert.equal(await choose(2), undefined);
    assert.equal(provider.inputs.length, 1);
  });

  it("never lets a decision run past the run's deadline", async () => {
    const { provider, stats, breaker, choose } = setup([{ hang: true }], { deadline: Date.now() + 50 });
    const { result, ms } = await timed(() => choose(1));
    assert.equal(result, undefined);
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.equal(stats.report().total.failedCalls, 0);
    assert.equal(breaker.trips, 0);
    // At the deadline no call is started at all.
    assert.equal(await choose(2), undefined);
    assert.equal(provider.inputs.length, 1);
  });
});
