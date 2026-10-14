import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Config, type LlmConfig, parseConfig } from "../src/config/config.ts";
import { LlmBreaker, LlmDriver } from "../src/llm/driver.ts";
import { PromptPlaceholders } from "../src/llm/placeholders.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "../src/llm/prompt.ts";
import { type DecideInput, LlmError } from "../src/llm/provider.ts";
import { StuckDetector } from "../src/llm/stuck.ts";
import { ACTION_TOOLS, parseToolCall } from "../src/llm/tools.ts";
import { describeUsage, estimateCost, LlmStats } from "../src/llm/usage.ts";
import type { Action } from "../src/monkey/actions.ts";
import type { StepRecord } from "../src/monkey/loop.ts";
import type { Snapshot, SnapshotElement } from "../src/snapshot/snapshot.ts";
import { FAKE_USAGE, FakeProvider } from "./helpers/fake-provider.ts";

const SECRET = "s3cr3t-Pa55";
const KEY = "key-0123456789";

function load(llm: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return parseConfig(
    JSON.stringify({
      baseUrl: "https://test.example.org",
      seed: 1,
      auth: [
        {
          name: "admin",
          loginUrl: "/login",
          fields: { username: "admin", password: "${ADMIN_PASS}" },
          submit: "button",
        },
      ],
      testData: { email: "monkey@test.local", iban: "DE89370400440532013000" },
      llm: {
        provider: "anthropic-foundry",
        baseUrl: "https://res.services.ai.azure.com/anthropic",
        deployment: "claude",
        apiKey: "${KEY}",
        ...llm,
      },
      ...extra,
    }),
    { env: { ADMIN_PASS: SECRET, KEY } },
  );
}

const button = (ref: string, name: string): SnapshotElement => ({
  ref,
  role: "button",
  name,
  enabled: true,
  inViewport: true,
  inFrame: false,
});
const textbox = (ref: string, name: string): SnapshotElement => ({ ...button(ref, name), role: "textbox" });

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    url: "https://test.example.org/",
    title: "Home",
    elements: [button("e1", "Save"), textbox("e2", "Name")],
    text: "Welcome",
    crossOriginFrames: 0,
    dialogs: [],
    hash: "h0",
    ...overrides,
  };
}

function record(step: number, action: Action, ok = true, source: "monkey" | "llm" = "monkey"): StepRecord {
  return {
    step,
    action,
    url: "https://test.example.org/",
    snapshotHash: "h0",
    source,
    result: { ok, ...(ok ? {} : { error: "boom" }), navigated: false, url: "https://test.example.org/", tab: 0 },
  };
}

describe("LLM tools", () => {
  const refs = new Set(["e1", "e2"]);

  it("declares every tool with a strict schema", () => {
    for (const tool of ACTION_TOOLS) {
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.ok(tool.description.length > 20, tool.name);
    }
    assert.deepEqual(
      ACTION_TOOLS.map((tool) => tool.name),
      [
        "click",
        "dblclick",
        "hover",
        "fill",
        "select",
        "check",
        "uncheck",
        "press",
        "scroll",
        "back",
        "navigate",
        "done",
      ],
    );
  });

  it("turns valid tool calls into actions", () => {
    assert.deepEqual(parseToolCall("click", { ref: "e1" }, refs), { type: "click", ref: "e1" });
    assert.deepEqual(parseToolCall("fill", { ref: "e2", value: "x" }, refs), { type: "fill", ref: "e2", value: "x" });
    assert.deepEqual(parseToolCall("press", { key: "Escape" }, refs), { type: "press", key: "Escape" });
    assert.deepEqual(parseToolCall("done", {}, refs), { type: "done" });
  });

  it("rejects refs that are not in the current snapshot", () => {
    assert.throws(
      () => parseToolCall("click", { ref: "e99" }, refs),
      (error: LlmError) => error.kind === "invalid" && /e99.*not in the current snapshot/.test(error.message),
    );
  });

  it("rejects schema-invalid input and unknown tools", () => {
    const invalid = (name: string, input: unknown) =>
      assert.throws(
        () => parseToolCall(name, input, refs),
        (error: LlmError) => error.kind === "invalid",
      );
    invalid("click", {});
    invalid("click", { ref: "e1", extra: true });
    invalid("fill", { ref: "e2", value: 42 });
    invalid("press", { key: "Meta+Q" });
    invalid("scroll", { deltaY: 1e9 });
    invalid("click", "e1");
    invalid("rm_rf", {});
    invalid("ping", { value: "x" });
  });
});

describe("prompt placeholders", () => {
  const { config, secrets } = load();
  const placeholders = new PromptPlaceholders(config, secrets);

  it("offers test data and login fields, not their values", () => {
    assert.deepEqual(placeholders.offered, [
      "{{testData.email}}",
      "{{testData.iban}}",
      "{{admin.username}}",
      "{{admin.password}}",
    ]);
  });

  it("hides secret values and fills placeholders back in", () => {
    assert.equal(placeholders.hide(`pw ${SECRET}!`), "pw {{env.ADMIN_PASS}}!");
    assert.equal(placeholders.fill("{{admin.password}}"), SECRET);
    assert.equal(placeholders.fill("{{env.ADMIN_PASS}}"), SECRET);
    assert.equal(placeholders.fill("a {{testData.email}} b {{nope}}"), "a monkey@test.local b {{nope}}");
    assert.deepEqual(placeholders.fillDecision({ type: "fill", ref: "e1", value: "{{admin.password}}" }), {
      type: "fill",
      ref: "e1",
      value: SECRET,
    });
  });

  it("builds a prompt with the snapshot last and no secrets", () => {
    const input: DecideInput = {
      snapshot: 'URL: https://test.example.org/\nElements (1 of 1):\ne1 button "Save"',
      refs: new Set(["e1"]),
      history: [{ step: 3, source: "monkey", action: "click e1", ok: false, error: "timeout", url: "/" }],
      findingsSoFar: ["high pageerror: boom"],
      goal: "a dialog is open",
      testDataKeys: ["email"],
      placeholders: placeholders.offered,
      role: "admin",
    };
    const message = buildUserMessage(input);
    assert.ok(message.endsWith("Choose the next action: exactly one tool call."));
    assert.ok(message.indexOf("Current page:") > message.indexOf("Findings so far"));
    assert.match(message, /3\. \[monkey\] click e1 on \/ -> failed: timeout/);
    assert.match(SYSTEM_PROMPT, /exactly one tool call/);
    assert.ok(!(message.includes(SECRET) || SYSTEM_PROMPT.includes(SECRET)));
  });
});

describe("stuck detection", () => {
  const limits = load().config.llm?.handoff as LlmConfig["handoff"];
  const detector = (options = {}) => new StuckDetector(limits, { authenticated: false, ...options });

  /** Feeds steps that each discover a new state on an ordinary page. */
  it("does not fire on a normal page while new states appear", () => {
    const d = detector({ authenticated: true, loginUrl: "https://test.example.org/login" });
    for (let i = 1; i <= 60; i++) {
      const s = snap({ hash: `h${i}`, url: `https://test.example.org/p${i % 7}` });
      d.observe(s, true);
      assert.equal(d.check(s), undefined, `step ${i}`);
      d.record(record(i, { type: "click", ref: "e1" }, i % 3 !== 0), s);
    }
  });

  it("fires on no state change", () => {
    const d = detector();
    const s = snap();
    d.observe(s, true);
    for (let i = 1; i < limits.noStateChange; i++) {
      d.observe(s, false);
      assert.equal(d.check(s), undefined);
    }
    d.observe(s, false);
    assert.equal(d.check(s)?.trigger, "noStateChange");
    d.reset();
    assert.equal(d.check(s), undefined);
  });

  it("fires on no progress across changing but known states", () => {
    const d = detector();
    d.observe(snap({ hash: "h0" }), true);
    d.observe(snap({ hash: "h1" }), true);
    // Alternating between two known states: the page changes, but nothing new is found.
    for (let i = 1; i <= limits.noProgress; i++) {
      const s = snap({ hash: `h${i % 2}` });
      d.observe(s, false);
      if (i < limits.noProgress) assert.equal(d.check(s), undefined, `step ${i}`);
    }
    assert.equal(d.check(snap())?.trigger, "noProgress");
  });

  it("fires on an open dialog and on a cookie banner", () => {
    const d = detector();
    const dialog = snap({ dialogs: ["Newsletter"] });
    d.observe(dialog, true);
    assert.deepEqual(d.check(dialog), { trigger: "blockingUi", detail: 'a dialog is open: "Newsletter"' });
    const banner = snap({ text: "We use cookies to improve the site.", elements: [button("e1", "Accept all")] });
    d.observe(banner, true);
    assert.equal(d.check(banner)?.trigger, "blockingUi");
    // The word alone is not a banner.
    const article = snap({ text: "A recipe for cookies", elements: [button("e1", "Print")] });
    d.observe(article, true);
    assert.equal(d.check(article), undefined);
  });

  it("fires when the monkey's actions keep failing, not on the LLM's", () => {
    const d = detector();
    const s = snap();
    for (let i = 1; i <= limits.failedActions; i++) {
      d.observe(snap({ hash: `h${i}` }), true);
      d.record(record(i, { type: "click", ref: "e1" }, false, i === 1 ? "llm" : "monkey"), s);
    }
    assert.equal(d.check(snap({ hash: "x" })), undefined);
    d.record(record(9, { type: "click", ref: "e1" }, false), s);
    assert.equal(d.check(snap({ hash: "x" }))?.trigger, "failedActions");
  });

  it("fires when a form keeps rejecting its input", () => {
    const d = detector();
    const form = snap({ url: "https://test.example.org/form", hash: "f0" });
    const rejected = (i: number) =>
      snap({ url: "https://test.example.org/form", hash: `f${i}`, text: "Please enter a valid email address." });
    d.observe(form, true);
    for (let i = 1; i <= limits.invalidForm; i++) {
      d.record(record(i, { type: "click", ref: "e1" }), form);
      d.observe(rejected(i), true);
    }
    assert.equal(d.check(rejected(9))?.trigger, "invalidForm");

    // A successful submission resets the count.
    const ok = detector();
    for (let i = 1; i <= limits.invalidForm; i++) {
      ok.record(record(i, { type: "click", ref: "e1" }), form);
      ok.observe(
        i === 2 ? snap({ url: "https://test.example.org/form", hash: "done", text: "Thanks!" }) : rejected(i),
        true,
      );
    }
    assert.equal(ok.check(form), undefined);
  });

  it("fires once when a logged-in role lands on a login page", () => {
    const login = snap({
      url: "https://test.example.org/signin",
      elements: [textbox("e1", "Password"), button("e2", "Sign in")],
    });
    const anonymous = detector();
    anonymous.observe(login, true);
    assert.equal(anonymous.check(login), undefined);

    const d = detector({ authenticated: true, loginUrl: "https://test.example.org/login" });
    d.observe(login, true);
    assert.equal(d.check(login)?.trigger, "loginWall");
    d.observe(login, false);
    assert.equal(d.check(login), undefined);
    const byUrl = detector({ authenticated: true, loginUrl: "https://test.example.org/login" });
    const loginUrl = snap({ url: "https://test.example.org/login?next=/", elements: [] });
    byUrl.observe(loginUrl, true);
    assert.equal(byUrl.check(loginUrl)?.trigger, "loginWall");
  });
});

describe("LLM driver", () => {
  /** A driver whose detector always reports a dialog, and a sequence of steps on one page. */
  function setup(
    script: ConstructorParameters<typeof FakeProvider>[0],
    llm: Record<string, unknown> = {},
    shared: { stats?: LlmStats; breaker?: LlmBreaker; run?: string } = {},
  ) {
    const { config, secrets } = load(llm);
    const provider = new FakeProvider(script);
    const stats = shared.stats ?? new LlmStats(config.llm as LlmConfig, provider.name);
    const lines: string[] = [];
    const driver = new LlmDriver({
      provider,
      config: config.llm as LlmConfig,
      stats,
      detector: new StuckDetector((config.llm as LlmConfig).handoff, { authenticated: true }),
      placeholders: new PromptPlaceholders(config, secrets),
      role: "admin",
      ...(shared.run === undefined ? {} : { run: shared.run }),
      ...(shared.breaker === undefined ? {} : { breaker: shared.breaker }),
      findings: () => [],
      origin: "https://test.example.org",
      log: (line) => lines.push(line),
    });
    const page = snap({ dialogs: ["Cookies"], text: `Hello ${SECRET}` });
    /** Runs one step; returns the LLM's action or undefined (monkey). */
    const step = async (n: number, monkey: Action = { type: "scroll", deltaY: 300 }) => {
      driver.observe(page, n === 1);
      const action = await driver.choose(page, n);
      driver.record(record(n, action ?? monkey, true, action === undefined ? "monkey" : "llm"), page);
      return action;
    };
    return { config, provider, stats, lines, step };
  }

  it("hands over, fills placeholders after the model call and never sends secrets", async () => {
    const { provider, stats, step } = setup([
      { tool: "fill", input: { ref: "e2", value: "{{admin.password}}" } },
      { tool: "click", input: { ref: "e1" } },
    ]);
    assert.deepEqual(await step(1), { type: "fill", ref: "e2", value: SECRET });
    assert.deepEqual(await step(2), { type: "click", ref: "e1" });
    // `done` ends the handoff: the monkey acts.
    assert.equal(await step(3), undefined);
    const sent = JSON.stringify(provider.inputs.map(({ refs, ...rest }) => ({ ...rest, refs: [...refs] })));
    assert.ok(!sent.includes(SECRET), sent);
    assert.ok(sent.includes("{{env.ADMIN_PASS}}"));
    // The history shows the LLM's placeholder, not the typed secret.
    assert.match(provider.inputs[1]?.history.at(-1)?.action ?? "", /fill e2 "\{\{admin\.password\}\}"/);
    assert.equal(provider.inputs[0]?.goal, 'a dialog is open: "Cookies"');
    const total = stats.report().total;
    assert.equal(total.calls, 3);
    assert.equal(total.actions, 2);
    assert.deepEqual(total.handoffs, { blockingUi: 1 });
  });

  it("gives the LLM at most maxDecisions in a row, then a cooldown for the monkey", async () => {
    const click = { tool: "click", input: { ref: "e1" } };
    const { step, provider } = setup([click, click, click, click, click], {
      handoff: { maxDecisions: 2, cooldownSteps: 3 },
    });
    const sources: string[] = [];
    for (let i = 1; i <= 8; i++) sources.push((await step(i)) === undefined ? "m" : "L");
    assert.deepEqual(sources.join(""), "LLmmmLLm");
    assert.equal(provider.inputs.length, 4);
  });

  it("retries a text-only answer once, then falls back to the monkey", async () => {
    const { step, stats, provider } = setup([
      { text: "I would click Save." },
      { tool: "click", input: { ref: "e1" } },
      { text: "Hmm." },
      { tool: "click", input: { ref: "e404" } },
    ]);
    assert.deepEqual(await step(1), { type: "click", ref: "e1" });
    assert.equal(await step(2), undefined);
    assert.equal(provider.inputs.length, 4);
    const total = stats.report().total;
    assert.deepEqual(total.errors, { invalid: 3 });
    assert.deepEqual(total.fallbacks, { invalid: 1 });
  });

  it("rejects navigation off the site", async () => {
    const { step, stats } = setup([
      { tool: "navigate", input: { url: "https://evil.example.com/" } },
      { tool: "navigate", input: { url: "/settings" } },
    ]);
    assert.deepEqual(await step(1), { type: "navigate", url: "https://test.example.org/settings" });
    assert.deepEqual(stats.report().total.errors, { invalid: 1 });
    // The rejected call still cost tokens.
    assert.equal(stats.report().total.inputTokens, 2 * FAKE_USAGE.inputTokens);
  });

  it("survives a provider that always throws and opens the circuit breaker", async () => {
    const down = { error: new LlmError("server", "500 Internal Server Error", { status: 500 }) };
    const { config, step, stats, provider, lines } = setup(
      Array.from({ length: 100 }, () => down),
      {
        handoff: { cooldownSteps: 0 },
        breaker: { failures: 3, pauseSteps: 10 },
      },
    );
    for (let i = 1; i <= 40; i++) assert.equal(await step(i), undefined);
    const total = stats.report().total;
    // Transport errors are not retried: one call per failed decision; 3 failures, then 10 paused steps.
    assert.equal(total.failedCalls, provider.inputs.length);
    assert.equal(total.breakerTrips, 3);
    assert.equal(total.fallbacks.server, 9 + 1);
    assert.ok(lines.some((line) => /pausing the LLM for 10 steps/.test(line)));
    assert.equal(config.llm?.breaker.failures, 3);
  });

  it("stops asking when the budget is spent and says so", async () => {
    const click = { tool: "click", input: { ref: "e1" } };
    const { step, stats, provider } = setup([click, click, click, click], {
      maxCalls: 2,
      handoff: { cooldownSteps: 0 },
    });
    for (let i = 1; i <= 6; i++) await step(i);
    assert.equal(provider.inputs.length, 2);
    assert.deepEqual(stats.report().budget, {
      maxCalls: 2,
      exhausted: { role: "admin", step: 3, reason: "llm.maxCalls (2) reached" },
    });
  });

  it("counts calls in flight against llm.maxCalls, so parallel runs cannot overspend", async () => {
    const click = { tool: "click", input: { ref: "e1" } };
    const first = setup([click, click], { maxCalls: 1 }, { run: "admin/1" });
    const second = setup([click, click], { maxCalls: 1 }, { stats: first.stats, run: "admin/2" });
    // Both ask at the same time; only one call fits the budget.
    const actions = await Promise.all([first.step(1), second.step(1)]);
    assert.equal(first.provider.inputs.length + second.provider.inputs.length, 1);
    assert.equal(actions.filter((action) => action !== undefined).length, 1);
    const report = first.stats.report();
    assert.equal(report.total.calls, 1);
    // The first run started its call before the second asked; usage is kept per run.
    assert.deepEqual(report.budget.exhausted, { role: "admin/2", step: 1, reason: "llm.maxCalls (1) reached" });
    assert.deepEqual(
      report.roles.map((r) => [r.role, r.calls]),
      [
        ["admin/1", 1],
        ["admin/2", 0],
      ],
    );
  });

  it("shares the circuit breaker: a trip in one run pauses the LLM in the others", async () => {
    const down = { error: new LlmError("server", "500 Internal Server Error", { status: 500 }) };
    const click = { tool: "click", input: { ref: "e1" } };
    const llm = { handoff: { cooldownSteps: 0 }, breaker: { failures: 3, pauseSteps: 5 } };
    const breaker = new LlmBreaker();
    const failing = setup([down, down, down], llm, { breaker, run: "a" });
    const healthy = setup(
      Array.from({ length: 10 }, () => click),
      llm,
      { stats: failing.stats, breaker, run: "b" },
    );
    assert.deepEqual(await healthy.step(1), { type: "click", ref: "e1" });
    for (let i = 1; i <= 3; i++) await failing.step(i);
    assert.equal(breaker.trips, 1);
    // Paused for steps 2 … 6 of the healthy run, then the LLM is back.
    for (let i = 2; i <= 6; i++) assert.equal(await healthy.step(i), undefined, `step ${i}`);
    assert.equal(healthy.provider.inputs.length, 1);
    assert.deepEqual(await healthy.step(7), { type: "click", ref: "e1" });
    assert.equal(failing.stats.report().total.breakerTrips, 1);
  });

  it("counts tokens against llm.maxTokens", async () => {
    const click = { tool: "click", input: { ref: "e1" } };
    const { step, provider, stats } = setup([click, click, click], { maxTokens: 2000 });
    for (let i = 1; i <= 3; i++) await step(i);
    // Each fake call reports 1000 + 20 + 500 tokens: the second call crosses the budget.
    assert.equal(provider.inputs.length, 2);
    assert.match(stats.report().budget.exhausted?.reason ?? "", /llm\.maxTokens \(2000\)/);
  });
});

describe("LLM usage", () => {
  const llm = load({ pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 } }).config.llm as LlmConfig;

  it("sums calls per role and in total, with latency percentiles and an estimated cost", () => {
    const stats = new LlmStats(llm, "fake");
    const latencies = [
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 5000,
    ];
    for (const [i, latencyMs] of latencies.entries()) {
      stats.call(i % 2 === 0 ? "a" : "b", {
        ok: i !== 3,
        ...(i === 3 ? { kind: "server" as const } : {}),
        usage: FAKE_USAGE,
        latencyMs,
        retries: i === 5 ? 2 : 0,
      });
    }
    const { total, roles } = stats.report();
    assert.equal(total.calls, 20);
    assert.equal(total.failedCalls, 1);
    assert.equal(total.inputTokens, 20 * FAKE_USAGE.inputTokens);
    assert.equal(total.outputTokens, 20 * FAKE_USAGE.outputTokens);
    assert.equal(total.cachedTokens, 20 * (FAKE_USAGE.cachedTokens ?? 0));
    assert.equal(total.retries, 2);
    assert.equal(total.p95LatencyMs, 1900);
    assert.equal(total.avgLatencyMs, 1200);
    assert.equal(roles.length, 2);
    assert.equal((roles[0]?.inputTokens ?? 0) + (roles[1]?.inputTokens ?? 0), total.inputTokens);
    // 20000 * 3 + 400 * 15 + 10000 * 0.3 per million.
    assert.equal(total.estimatedCost, 0.069);
    assert.match(
      describeUsage(total),
      /^llm: 20 calls \(1 failed\), 20000 in \/ 400 out tokens \(10000 cached\), .*est\. cost 0\.069$/,
    );
  });

  it("prices cache tokens at the input price unless given", () => {
    assert.equal(
      estimateCost(
        { inputTokens: 1e6, outputTokens: 0, cachedTokens: 1e6, cacheWriteTokens: 1e6 },
        { inputPerMTok: 2, outputPerMTok: 10 },
      ),
      6,
    );
  });

  it("has no cost without pricing", () => {
    const config = load().config as Config;
    assert.equal(new LlmStats(config.llm as LlmConfig, "fake").report().total.estimatedCost, undefined);
  });
});
