import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { type DecideInput, LlmError, type LlmErrorKind } from "../src/llm/provider.ts";
import type { ActionLog } from "../src/replay/log.ts";
import type { Report } from "../src/report/report.ts";
import { FAKE_USAGE, FakeProvider, type FakeScript } from "./helpers/fake-provider.ts";

const KEY = "sk-test-key-0123456789";
const PASSWORD = FIXTURE_CREDENTIALS.password;

/** The ref of the first element in the serialized snapshot matching `role "name"`. */
function refOf(input: DecideInput, role: string, name: RegExp): string | undefined {
  for (const line of input.snapshot.split("\n")) {
    const match = /^(\w+) (\w+) "([^"]*)"/.exec(line);
    if (match !== null && match[2] === role && name.test(match[3] as string)) return match[1];
  }
  return undefined;
}

/** Goes to the contact form and fills its fields with placeholders, including the role's password. */
const formFiller: FakeScript = (input) => {
  const link = refOf(input, "link", /^Contact form$/);
  if (link !== undefined) return { tool: "click", input: { ref: link } };
  const name = refOf(input, "textbox", /^Name/);
  if (name !== undefined && !input.history.some((h) => h.action.includes("{{user.password}}"))) {
    return { tool: "fill", input: { ref: name, value: "{{user.password}}" } };
  }
  const email = refOf(input, "textbox", /mail/i);
  if (email !== undefined) return { tool: "fill", input: { ref: email, value: "{{testData.email}}" } };
  return { tool: "done", input: { note: "nothing to do" } };
};

describe("monkey run with an LLM against the fixture site", () => {
  let site: Fixture;
  let dir: string;
  before(async () => {
    site = await startFixture();
    dir = await mkdtemp(join(tmpdir(), "monkey-llm-"));
  });
  after(() => site?.close());

  async function run(
    config: Record<string, unknown>,
    provider?: FakeProvider,
    command: "run" | "preflight" = "run",
  ): Promise<{ code: number; stdout: string; stderr: string; dir: string }> {
    const name = `run-${Math.random().toString(36).slice(2)}`;
    const file = join(dir, `${name}.json`);
    const llm = config.llm === undefined ? {} : { llm: { ...LLM, ...(config.llm as object) } };
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: site.url,
        seed: 11,
        limits: { maxSteps: 12 },
        auth: [
          {
            name: "user",
            loginUrl: "/login",
            fields: { username: "${FIXTURE_USER}", password: "${FIXTURE_PASS}" },
            submit: "button[type=submit]",
          },
        ],
        testData: { email: "monkey@test.local" },
        report: { dir: name },
        ...config,
        ...llm,
      }),
    );
    let stdout = "";
    let stderr = "";
    const code = await runCli([command, file], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: { FIXTURE_USER: FIXTURE_CREDENTIALS.username, FIXTURE_PASS: PASSWORD, FOUNDRY_API_KEY: KEY },
      ...(provider === undefined ? {} : { llmProvider: () => provider }),
    });
    return { code, stdout, stderr, dir: join(dir, name) };
  }

  const LLM = {
    provider: "anthropic-foundry",
    baseUrl: "https://res.services.ai.azure.com/anthropic",
    deployment: "claude",
    apiKey: "${FOUNDRY_API_KEY}",
  };
  /** Hand over at once and often. */
  const EAGER = { noProgress: 1, noStateChange: 1, maxDecisions: 3, cooldownSteps: 1 };
  /** Never hand over. */
  const NEVER = {
    noProgress: 9999,
    noStateChange: 9999,
    failedActions: 9999,
    invalidForm: 9999,
    blockingUi: false,
    loginWall: false,
  };

  const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

  it("lets the LLM act, substitutes placeholders after the call, and accounts for every call", async () => {
    const provider = new FakeProvider([], formFiller);
    const result = await run({ llm: { handoff: EAGER, debugLog: true } }, provider);
    assert.ok(result.code === 0 || result.code === 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /llm preflight ok: fake at https:\/\/res\.services\.ai\.azure\.com\/anthropic/);
    assert.match(result.stdout, /handing over to the LLM/);

    const log = await readJson<ActionLog>(join(result.dir, "user", "actions.json"));
    const llmActions = log.actions.filter((action) => action.source === "llm");
    assert.ok(llmActions.length >= 2, JSON.stringify(log.actions.map((a) => [a.source, a.type])));
    // The password went into the page, but the log keeps the placeholder of the environment variable.
    const typed = llmActions.find((action) => action.type === "fill" && action.value === "${FIXTURE_PASS}");
    assert.ok(typed !== undefined, JSON.stringify(llmActions));

    // No secret ever reached the provider.
    const sent = JSON.stringify(provider.inputs.map(({ refs, ...rest }) => rest));
    assert.ok(!sent.includes(PASSWORD) && !sent.includes(KEY));
    assert.ok(
      provider.inputs.every((input) => input.role === "user" && input.placeholders.includes("{{user.password}}")),
    );

    const report = await readJson<Report>(join(result.dir, "report.json"));
    const llm = report.llm;
    assert.ok(llm !== undefined);
    assert.equal(llm.status, "active");
    assert.equal(llm.total.calls, provider.inputs.length);
    assert.equal(llm.total.inputTokens, provider.inputs.length * FAKE_USAGE.inputTokens);
    assert.equal(llm.total.outputTokens, provider.inputs.length * FAKE_USAGE.outputTokens);
    assert.equal(llm.total.actions, llmActions.length);
    assert.deepEqual(
      llm.roles.map((role) => [role.role, role.calls]),
      [["user", provider.inputs.length]],
    );
    assert.match(result.stdout, new RegExp(`\\[user\\] llm: ${provider.inputs.length} calls`));
    assert.match(result.stdout, new RegExp(`\\nllm: ${provider.inputs.length} calls`));

    const html = await readFile(join(result.dir, "report.html"), "utf8");
    assert.match(html, /<h2>LLM usage<\/h2>/);

    // The debug log is written on request, without secrets.
    const debug = await readFile(join(result.dir, "llm-debug.jsonl"), "utf8");
    const lines = debug.trim().split("\n");
    assert.equal(lines.length, provider.inputs.length);
    assert.match(JSON.parse(lines[0] as string).prompt, /Current page:/);
    for (const text of [debug, html, JSON.stringify(report), JSON.stringify(log), result.stdout]) {
      assert.ok(!text.includes(PASSWORD) && !text.includes(KEY));
    }
  });

  it("takes the same monkey actions as without llm while nothing hands over", async () => {
    const plain = await run({});
    const provider = new FakeProvider([{ error: new LlmError("other", "must not be called") }]);
    const withLlm = await run({ llm: { handoff: NEVER } }, provider);
    const actions = async (path: string) =>
      (await readJson<ActionLog>(join(path, "user", "actions.json"))).actions.map(
        ({ type, source, pageUrl, ...rest }) => ({
          type,
          source,
          pageUrl,
          value: (rest as { value?: string }).value,
          locator: rest.locator,
        }),
      );
    assert.equal(provider.inputs.length, 0);
    assert.deepEqual(await actions(withLlm.dir), await actions(plain.dir));
    // Without llm, the run prints and writes nothing about it.
    assert.doesNotMatch(plain.stdout, /llm preflight|\] llm:|^llm:/m);
    assert.equal((await readJson<Report>(join(plain.dir, "report.json"))).llm, undefined);
    assert.equal(existsSync(join(withLlm.dir, "llm-debug.jsonl")), false);
  });

  it("continues as pure monkey when the budget is spent and says so", async () => {
    const provider = new FakeProvider([], { tool: "scroll", input: { deltaY: 300 } });
    const result = await run({ llm: { handoff: EAGER, maxCalls: 2 } }, provider);
    assert.equal(provider.inputs.length, 2);
    assert.match(result.stdout, /llm\.maxCalls \(2\) reached; continuing as pure monkey/);
    assert.match(result.stdout, /\nllm budget exhausted at step \d+ of role user: llm\.maxCalls \(2\) reached\n/);
    const report = await readJson<Report>(join(result.dir, "report.json"));
    assert.equal(report.llm?.budget.exhausted?.reason, "llm.maxCalls (2) reached");
    assert.match(await readFile(join(result.dir, "report.html"), "utf8"), /Budget exhausted at step/);
    // No prompt content is written without llm.debugLog.
    assert.equal(existsSync(join(result.dir, "llm-debug.jsonl")), false);
  });

  it("never aborts the run when the provider always fails, and reports the failures", async () => {
    const provider = new FakeProvider([], {
      error: new LlmError("server", "500 Internal Server Error", { status: 500 }),
    });
    const result = await run(
      { llm: { handoff: { ...EAGER, cooldownSteps: 0 }, breaker: { failures: 2, pauseSteps: 3 } } },
      provider,
    );
    assert.ok(result.code === 0 || result.code === 1, result.stdout);
    assert.match(result.stdout, /\[user\] 12 steps .*stopped: maxSteps/);
    const report = await readJson<Report>(join(result.dir, "report.json"));
    const total = report.llm?.total;
    assert.ok(total !== undefined && total.calls > 0);
    assert.equal(total.failedCalls, total.calls);
    assert.equal(total.errors.server, total.calls);
    assert.ok(total.breakerTrips >= 1);
    assert.equal(total.fallbacks.server, total.calls);
    const log = await readJson<ActionLog>(join(result.dir, "user", "actions.json"));
    assert.ok(log.actions.every((action) => action.source === "monkey"));
  });

  describe("preflight", () => {
    const failing = (kind: LlmErrorKind, status?: number) => {
      const provider = new FakeProvider();
      provider.preflightResult = {
        ok: false,
        error: new LlmError(kind, `HTTP error with ${KEY}`.replace(KEY, "***"), status === undefined ? {} : { status }),
      };
      return provider;
    };

    const classes: [LlmErrorKind, number | undefined, RegExp][] = [
      ["unreachable", undefined, /endpoint not reachable/],
      ["tls", undefined, /TLS handshake failed/],
      ["auth", 401, /authentication failed: check llm\.apiKey/],
      ["forbidden", 403, /access denied/],
      ["notFound", 404, /deployment name not found: llm\.deployment must be the Foundry deployment name/],
      ["invalid", undefined, /tool calling unsupported/],
      ["rateLimited", 429, /rate limited/],
    ];
    for (const [kind, status, hint] of classes) {
      it(`stops the run before the browser on ${kind}`, async () => {
        const result = await run({ llm: {} }, failing(kind, status));
        assert.equal(result.code, 2);
        assert.match(
          result.stderr,
          /monkey run: llm preflight failed: fake at https:\/\/res\.services\.ai\.azure\.com\/anthropic, deployment claude/,
        );
        assert.match(result.stderr, new RegExp(`cause: ${kind}:`));
        assert.match(result.stderr, hint);
        if (status !== undefined) assert.match(result.stderr, new RegExp(`HTTP ${status}`));
        assert.ok(!result.stdout.includes("starting"), "no role started");
        assert.ok(!(result.stdout + result.stderr).includes(KEY));
      });
    }

    it("continues as pure monkey with llm.required false", async () => {
      const provider = failing("auth", 401);
      const result = await run({ llm: { required: false, handoff: EAGER } }, provider);
      assert.notEqual(result.code, 2, result.stderr);
      assert.match(
        result.stderr,
        /warning: llm preflight failed.*\n.*\n.*\n {2}llm\.required is false: continuing as pure random monkey/,
      );
      assert.equal(provider.inputs.length, 0);
      const report = await readJson<Report>(join(result.dir, "report.json"));
      assert.equal(report.llm?.status, "disabled");
      assert.equal(report.llm?.disabledReason, "preflight failed (auth)");
      assert.equal(report.llm?.preflight?.ok, false);
      assert.match(result.stdout, /\nllm: 0 calls.* \(disabled\)\n/);
    });

    it("runs alone with monkey preflight", async () => {
      const ok = await run({ llm: {} }, new FakeProvider(), "preflight");
      assert.equal(ok.code, 0);
      assert.match(ok.stdout, /^llm preflight ok: fake at /);
      const bad = await run({ llm: { required: false } }, failing("notFound", 404), "preflight");
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /monkey preflight: llm preflight failed/);
      const none = await run({}, undefined, "preflight");
      assert.equal(none.code, 2);
      assert.match(none.stderr, /no llm section/);
    });

    it("creates the openai provider and fails fast when its endpoint is unreachable", async () => {
      const result = await run(
        { llm: { provider: "openai", baseUrl: "http://127.0.0.1:1/openai/v1", maxRetries: 0 } },
        undefined,
        "preflight",
      );
      assert.equal(result.code, 2);
      assert.match(
        result.stderr,
        /llm preflight failed: openai at http:\/\/127\.0\.0\.1:1\/openai\/v1, deployment claude/,
      );
      assert.match(result.stderr, /cause: unreachable/);
      assert.ok(!result.stderr.includes(KEY));
    });
  });
});
