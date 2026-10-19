import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Page } from "playwright";
import { type LlmConfig, parseConfig } from "../src/config/config.ts";
import { DebugLog } from "../src/llm/debug-log.ts";
import { LlmDriver } from "../src/llm/driver.ts";
import { PromptPlaceholders } from "../src/llm/placeholders.ts";
import { buildUserMessage, SYSTEM_PROMPT, systemPrompt } from "../src/llm/prompt.ts";
import type { Capture } from "../src/llm/screenshot.ts";
import { StuckDetector } from "../src/llm/stuck.ts";
import { LlmStats } from "../src/llm/usage.ts";
import type { Action } from "../src/monkey/actions.ts";
import type { Snapshot } from "../src/snapshot/snapshot.ts";
import { FakeProvider, type FakeScript } from "./helpers/fake-provider.ts";

const KEY = "key-0123456789";
const SECRET = "s3cr3t-Pa55";
const SHOT: Capture = { ok: true, hidden: 1, screenshot: { mediaType: "image/jpeg", data: "/9j/c2hvdA==" } };
/** Stands in for a page: the driver only hands it to the capture function. */
const PAGE = {} as Page;

function load(llm: Record<string, unknown>) {
  return parseConfig(
    JSON.stringify({
      baseUrl: "https://test.example.org",
      seed: 1,
      testData: { email: "${MAIL}" },
      llm: {
        provider: "openai",
        baseUrl: "https://res.openai.azure.com/openai/v1",
        deployment: "model",
        apiKey: "${KEY}",
        ...llm,
      },
    }),
    { env: { KEY, MAIL: SECRET } },
  );
}

/** A page where nothing is stuck: no dialog, and every snapshot is a new state. */
const snapshot: Snapshot = {
  url: "https://test.example.org/",
  title: "Home",
  elements: [{ ref: "e1", role: "button", name: "Save", enabled: true, inViewport: true, inFrame: false }],
  text: "Welcome",
  crossOriginFrames: 0,
  dialogs: [],
  hash: "h0",
};

function setup(
  llm: Record<string, unknown>,
  options: { script?: FakeScript[]; capture?: () => Promise<Capture> } = {},
) {
  const { config, secrets } = load(llm);
  const provider = new FakeProvider(options.script ?? [], { tool: "click", input: { ref: "e1" } });
  const stats = new LlmStats(config.llm as LlmConfig, provider.name);
  const lines: string[] = [];
  let captures = 0;
  const driver = new LlmDriver({
    provider,
    config: config.llm as LlmConfig,
    stats,
    detector: new StuckDetector((config.llm as LlmConfig).handoff, { authenticated: false }),
    placeholders: new PromptPlaceholders(config, secrets),
    role: "anonymous",
    findings: () => [],
    log: (line) => lines.push(line),
    capture: () => {
      captures++;
      return options.capture?.() ?? Promise.resolve(SHOT);
    },
  });
  const step = async (n: number) => {
    driver.observe({ ...snapshot, hash: `h${n}` }, true);
    const action = await driver.choose({ ...snapshot, hash: `h${n}` }, n, PAGE);
    const done: Action = action ?? { type: "scroll", deltaY: 100 };
    const result = { ok: true, navigated: false, url: snapshot.url, tab: 0 };
    driver.record(
      {
        step: n,
        action: done,
        url: snapshot.url,
        snapshotHash: `h${n}`,
        source: action === undefined ? "monkey" : "llm",
        result,
      },
      snapshot,
    );
    return action === undefined ? "m" : "L";
  };
  return { provider, stats, lines, step, captures: () => captures };
}

describe("agent mode", () => {
  it("drives in turns of llm.agent.maxDecisions with llm.agent.monkeySteps in between, stuck or not", async () => {
    const { step, stats, provider } = setup({
      mode: "agent",
      maxCalls: 50,
      agent: { maxDecisions: 3, monkeySteps: 2 },
    });
    let sources = "";
    for (let n = 1; n <= 10; n++) sources += await step(n);
    assert.equal(sources, "LLLmmLLLmm");
    assert.deepEqual(stats.report().total.handoffs, { agent: 2 });
    assert.equal(provider.inputs[0]?.goal, "your turn: continue exploring");
  });

  it("ends a turn early on done and still pauses for the monkey", async () => {
    const { step } = setup(
      { mode: "agent", maxCalls: 50, agent: { maxDecisions: 5, monkeySteps: 1 } },
      {
        script: [
          { tool: "click", input: { ref: "e1" } },
          { tool: "done", input: {} },
        ],
      },
    );
    let sources = "";
    for (let n = 1; n <= 5; n++) sources += await step(n);
    assert.equal(sources, "LmmLL");
  });

  it("keeps handoff mode as it was: no LLM while the monkey is not stuck", async () => {
    const { step, provider } = setup({});
    for (let n = 1; n <= 5; n++) assert.equal(await step(n), "m");
    assert.equal(provider.inputs.length, 0);
  });

  it("stops at llm.maxCalls, which agent mode requires", async () => {
    const { step, provider, stats } = setup({ mode: "agent", maxCalls: 3 });
    for (let n = 1; n <= 8; n++) await step(n);
    assert.equal(provider.inputs.length, 3);
    assert.match(stats.report().budget.exhausted?.reason ?? "", /llm\.maxCalls \(3\)/);
    assert.throws(() => load({ mode: "agent" }), /llm\.maxCalls: is required with llm\.mode agent/);
    assert.throws(() => load({ agent: { maxDecisions: 2 } }), /llm\.agent: is only used with llm\.mode agent/);
  });

  it("puts llm.goal into every prompt, secrets hidden", async () => {
    const { step, provider } = setup({ mode: "agent", maxCalls: 5, goal: `Buy something as ${SECRET}` });
    await step(1);
    const input = provider.inputs[0];
    assert.equal(input?.objective, "Buy something as {{env.MAIL}}");
    assert.match(buildUserMessage(input as NonNullable<typeof input>), /^Goal of this run: Buy something as \{\{env/m);
  });

  it("tells the model its role in the system prompt", () => {
    assert.equal(systemPrompt({ mode: "handoff", vision: false }), SYSTEM_PROMPT);
    const agent = systemPrompt({ mode: "agent", vision: true });
    assert.match(agent, /You drive the browser in turns/);
    assert.match(agent, /screenshot of the visible part of the page may be attached/);
    assert.doesNotMatch(SYSTEM_PROMPT, /screenshot/);
    for (const prompt of [agent, SYSTEM_PROMPT]) assert.match(prompt, /exactly one tool call and no other text\.$/);
  });
});

describe("vision", () => {
  it("attaches a masked screenshot to every decision with llm.vision, and only then", async () => {
    const on = setup({ vision: true, mode: "agent", maxCalls: 5 });
    await on.step(1);
    assert.deepEqual(on.provider.inputs[0]?.screenshot, SHOT.ok ? SHOT.screenshot : undefined);
    assert.match(buildUserMessage(on.provider.inputs[0] as never), /A screenshot of the visible part/);
    assert.equal(on.captures(), 1);

    const off = setup({ mode: "agent", maxCalls: 5 });
    await off.step(1);
    assert.equal(off.provider.inputs[0]?.screenshot, undefined);
    assert.equal(off.captures(), 0);
  });

  it("asks without a screenshot when the page cannot be captured safely, and says why", async () => {
    const { step, provider, lines } = setup(
      { vision: true, mode: "agent", maxCalls: 5 },
      { capture: () => Promise.resolve({ ok: false, reason: "a frame could not be checked for secrets in time" }) },
    );
    assert.equal(await step(1), "L");
    assert.equal(provider.inputs[0]?.screenshot, undefined);
    assert.ok(lines.includes("step 1: no screenshot for the LLM: a frame could not be checked for secrets in time"));
  });

  it("describes the screenshot in the debug log instead of writing it", async () => {
    const { config, secrets } = load({});
    const file = join(await mkdtemp(join(tmpdir(), "monkey-debug-")), "llm-debug.jsonl");
    const log = new DebugLog(file, secrets);
    const placeholders = new PromptPlaceholders(config, secrets);
    const input = {
      snapshot: `Welcome ${placeholders.hide(SECRET)}`,
      refs: new Set(["e1"]),
      history: [],
      findingsSoFar: [],
      goal: "your turn",
      testDataKeys: [],
      placeholders: [],
      role: "anonymous",
      screenshot: { mediaType: "image/jpeg" as const, data: "A".repeat(4000) },
    };
    await log.write({ role: "anonymous", step: 1, attempt: 1, input });
    await log.write({
      role: "anonymous",
      step: 2,
      attempt: 1,
      input: { page: "/", viewport: { width: 10, height: 10 }, screenshot: input.screenshot },
      result: [],
    });
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("A".repeat(100)));
    const [decision, visual] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(decision.input.screenshot, "image/jpeg, about 3000 bytes (not logged)");
    assert.match(visual.prompt, /^Page: \/\nViewport: 10x10/);
    assert.ok(!text.includes(SECRET));
  });
});
