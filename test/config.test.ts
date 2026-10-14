import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli/cli.ts";
import { ConfigError, type LoadedConfig, loadConfig, parseConfig } from "../src/config/config.ts";
import { maskSecrets } from "../src/config/secrets.ts";
import { MAX_SEED } from "../src/config/values.ts";

const SECRET = "s3cr3t-Pa55word!";
const ENV = { ADMIN_USER: "admin", ADMIN_PASS: SECRET, FOUNDRY_API_KEY: "key-1234567890" };

function parse(config: unknown, env: NodeJS.ProcessEnv = ENV): LoadedConfig {
  return parseConfig(JSON.stringify(config), { env, baseDir: "/configs" });
}

/** Returns the issues of the ConfigError thrown by `fn`, formatted as `path: message`. */
function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
  assert.fail("expected a ConfigError");
}

const fullConfig = {
  baseUrl: "https://test.example.org",
  seed: 42,
  limits: { maxSteps: 100, maxMinutes: 5 },
  browser: { engine: "firefox", viewport: [800, 600], headless: false },
  stayOnDomain: false,
  auth: [
    {
      name: "admin",
      loginUrl: "/login",
      fields: { username: "${ADMIN_USER}", password: "${ADMIN_PASS}" },
      submit: "button[type=submit]",
    },
    { name: "user", storageState: "./states/user.json" },
  ],
  testData: { email: "monkey@test.local" },
  llm: {
    provider: "anthropic-foundry",
    baseUrl: "https://resource.services.ai.azure.com/anthropic",
    deployment: "my-deployment",
    apiKey: "${FOUNDRY_API_KEY}",
  },
  oracles: { overflow: false },
  report: { dir: "out" },
};

describe("parseConfig", () => {
  it("applies all defaults to a minimal config", () => {
    const { config, seedGenerated } = parse({ baseUrl: "https://test.example.org", seed: 7 });
    assert.equal(seedGenerated, false);
    assert.deepEqual(config, {
      baseUrl: "https://test.example.org",
      seed: 7,
      parallel: 1,
      limits: { maxSteps: 500, maxMinutes: 20 },
      browser: { engine: "chromium", viewport: [1280, 800], headless: true },
      stayOnDomain: true,
      scope: { allow: [], deny: [] },
      auth: [],
      testData: {},
      oracles: {
        pageerror: true,
        console: true,
        http5xx: true,
        http4xx: true,
        crash: true,
        hang: true,
        errorPage: true,
        overflow: true,
        download: true,
      },
      findings: { lastActions: 10, ignoreStatus: [], ignore: [] },
      report: { dir: resolve("/configs/monkey-report"), keepDownloads: false },
      monkey: {
        actionTimeoutMs: 5000,
        maxTabs: 5,
        weights: {
          click: 10,
          dblclick: 0.5,
          rightclick: 0.5,
          hover: 1,
          longPress: 0.3,
          drag: 0.3,
          fill: 6,
          select: 3,
          check: 3,
          press: 1,
          scroll: 1,
          back: 1.5,
          navigate: 1,
          setViewport: 0.2,
          switchTab: 1,
        },
      },
    });
    assert.equal("llm" in config, false);
  });

  it("generates a seed when none is configured", () => {
    const { config, seedGenerated } = parse({ baseUrl: "https://test.example.org" });
    assert.equal(seedGenerated, true);
    assert.ok(Number.isInteger(config.seed) && config.seed >= 0 && config.seed <= MAX_SEED);
  });

  it("accepts a full config and resolves placeholders and relative paths", () => {
    const { config } = parse(fullConfig);
    assert.deepEqual(config.auth, [
      {
        kind: "fields",
        name: "admin",
        loginUrl: "/login",
        fields: { username: "admin", password: SECRET },
        submit: "button[type=submit]",
      },
      { kind: "storageState", name: "user", storageState: resolve("/configs/states/user.json") },
    ]);
    assert.equal(config.llm?.apiKey, ENV.FOUNDRY_API_KEY);
    assert.equal(config.oracles.overflow, false);
    assert.equal(config.oracles.console, true);
    assert.deepEqual(config.browser, { engine: "firefox", viewport: [800, 600], headless: false });
    assert.equal(config.report.dir, resolve("/configs/out"));
  });

  it("resolves placeholders embedded in longer strings", () => {
    const { config } = parse({ baseUrl: "https://${HOST}:8080/app", seed: 1 }, { HOST: "test.local" });
    assert.equal(config.baseUrl, "https://test.local:8080/app");
  });

  it("does not expand placeholders inside substituted values", () => {
    const { config } = parse({ baseUrl: "https://x.test", seed: 1, testData: { a: "${A}" } }, { A: "${B}", B: "nope" });
    assert.equal(config.testData.a, "${B}");
  });

  it("rejects unknown keys at every level", () => {
    const issues = issuesOf(() =>
      parse({
        baseUrl: "https://x.test",
        bogus: 1,
        limits: { maxStep: 3 },
        auth: [{ name: "a", storageState: "s", x: 1 }],
      }),
    );
    assert.deepEqual(issues.sort(), ["auth[0].x: unknown key", "bogus: unknown key", "limits.maxStep: unknown key"]);
  });

  it("allows a $schema key for editor support", () => {
    assert.doesNotThrow(() => parse({ $schema: "./schema.json", baseUrl: "https://x.test" }));
  });

  it("names the config path and variable when an env var is unset", () => {
    const issues = issuesOf(() => parse(fullConfig, { ADMIN_USER: "admin", FOUNDRY_API_KEY: "k" }));
    assert.deepEqual(issues, ["auth[0].fields.password: environment variable ADMIN_PASS is not set"]);
  });

  it("rejects a role with both fields and storageState", () => {
    const issues = issuesOf(() =>
      parse({
        baseUrl: "https://x.test",
        auth: [{ name: "a", loginUrl: "/l", fields: { u: "x" }, submit: "b", storageState: "s.json" }],
      }),
    );
    assert.deepEqual(issues, ["auth[0]: use either fields (with loginUrl and submit) or storageState, not both"]);
  });

  it("rejects a role with neither fields nor storageState", () => {
    const issues = issuesOf(() => parse({ baseUrl: "https://x.test", auth: [{ name: "a" }] }));
    assert.deepEqual(issues, ["auth[0]: needs either fields (with loginUrl and submit) or storageState"]);
  });

  it("requires loginUrl and submit with fields, and forbids them with storageState", () => {
    const issues = issuesOf(() =>
      parse({
        baseUrl: "https://x.test",
        auth: [
          { name: "a", fields: { u: "x" } },
          { name: "b", storageState: "s.json", submit: "button" },
        ],
      }),
    );
    assert.deepEqual(issues, [
      "auth[0].loginUrl: is required with fields",
      "auth[0].submit: is required with fields",
      "auth[1].submit: is only allowed with fields, not with storageState",
    ]);
  });

  it("rejects duplicate role names", () => {
    const issues = issuesOf(() =>
      parse({
        baseUrl: "https://x.test",
        auth: [
          { name: "a", storageState: "1.json" },
          { name: "a", storageState: "2.json" },
        ],
      }),
    );
    assert.deepEqual(issues, ["auth[1].name: duplicate role name, already used by auth[0]"]);
  });

  for (const [label, viewport, expected] of [
    ["too many items", [1, 2, 3], "browser.viewport: must NOT have more than 2 items"],
    ["too few items", [1280], "browser.viewport: must NOT have fewer than 2 items"],
    ["zero width", [0, 800], "browser.viewport[0]: must be >= 1"],
    ["non-integer", [1280.5, 800], "browser.viewport[0]: must be integer"],
    ["not an array", "1280x800", "browser.viewport: must be array"],
  ] as const) {
    it(`rejects an invalid viewport (${label})`, () => {
      assert.deepEqual(
        issuesOf(() => parse({ baseUrl: "https://x.test", browser: { viewport } })),
        [expected],
      );
    });
  }

  it("runs several seeds: the first is the seed, and seed and seeds exclude each other", () => {
    const { config, seedGenerated } = parse({ baseUrl: "https://x.test", seeds: [8, 3], parallel: 4 });
    assert.equal(seedGenerated, false);
    assert.equal(config.seed, 8);
    assert.deepEqual(config.seeds, [8, 3]);
    assert.equal(config.parallel, 4);
    assert.equal(parse({ baseUrl: "https://x.test", seed: 1 }).config.seeds, undefined);
    assert.deepEqual(
      issuesOf(() => parse({ baseUrl: "https://x.test", seed: 1, seeds: [2] })),
      ["seeds: use either seed or seeds, not both"],
    );
    assert.deepEqual(issuesOf(() => parse({ baseUrl: "https://x.test", seeds: [2, 2], parallel: 0 })).sort(), [
      "parallel: must be >= 1",
      "seeds: must NOT have duplicate items (items ## 1 and 0 are identical)",
    ]);
    assert.deepEqual(
      issuesOf(() => parse({ baseUrl: "https://x.test", seeds: [] })),
      ["seeds: must NOT have fewer than 1 items"],
    );
  });

  it("rejects values of the wrong type or range", () => {
    const issues = issuesOf(() =>
      parse({
        baseUrl: "ftp://x.test",
        seed: -1,
        limits: { maxSteps: 0, maxMinutes: 0 },
        browser: { engine: "netscape" },
        stayOnDomain: "yes",
      }),
    );
    assert.deepEqual(issues.sort(), [
      "baseUrl: must be an absolute http(s) URL",
      "browser.engine: must be one of: chromium, firefox, webkit",
      "limits.maxMinutes: must be > 0",
      "limits.maxSteps: must be >= 1",
      "seed: must be >= 0",
      "stayOnDomain: must be boolean",
    ]);
  });

  it("accepts findings settings and checks ignore rules", () => {
    const findings = {
      lastActions: 3,
      ignoreStatus: [401, 403],
      ignore: [{ oracle: "console", message: "^Third party" }, { url: "analytics\\.example" }],
    };
    assert.deepEqual(parse({ baseUrl: "https://x.test", seed: 1, findings }).config.findings, findings);
    const issues = issuesOf(() =>
      parse({
        baseUrl: "https://x.test",
        findings: {
          lastActions: -1,
          ignoreStatus: [200, 404, 404],
          ignore: [{ oracle: "console" }, { url: "(" }, { oracle: "nope", message: "x" }],
        },
      }),
    );
    assert.deepEqual(issues.sort(), [
      "findings.ignoreStatus: must NOT have duplicate items (items ## 2 and 1 are identical)",
      "findings.ignoreStatus[0]: must be >= 400",
      "findings.ignore[0]: needs url or message; use oracles.<name>: false to switch an oracle off",
      "findings.ignore[1].url: is not a valid regular expression",
      "findings.ignore[2].oracle: must be one of: pageerror, console, http5xx, http4xx, crash, hang, errorPage, overflow, download",
      "findings.lastActions: must be >= 0",
    ]);
  });

  it("rejects null values", () => {
    assert.deepEqual(
      issuesOf(() => parse({ baseUrl: "https://x.test", seed: null })),
      ["seed: null is not allowed; omit the key to use the default"],
    );
  });

  it("requires baseUrl and a complete llm section", () => {
    const issues = issuesOf(() => parse({ llm: { provider: "openai" } }));
    assert.deepEqual(issues.sort(), [
      "baseUrl: is required",
      "llm.apiKey: is required",
      "llm.baseUrl: is required",
      "llm.deployment: is required",
    ]);
  });

  it("reports invalid JSON", () => {
    const issues = issuesOf(() => parseConfig("{ nope", { env: {} }));
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /^\(file\): invalid JSON/);
  });

  it("lists all problems at once", () => {
    const issues = issuesOf(() =>
      parse({ baseUrl: "https://x.test", bogus: true, seed: "x", auth: [{ name: "a" }] }, {}),
    );
    assert.equal(issues.length, 3);
  });
});

describe("secret masking", () => {
  it("masks every placeholder value in the config", () => {
    const { config, secrets } = parse(fullConfig);
    const masked = maskSecrets(config, secrets);
    const json = JSON.stringify(masked);
    assert.ok(!json.includes(SECRET));
    assert.ok(!json.includes(ENV.FOUNDRY_API_KEY));
    assert.equal(masked.llm?.apiKey, "***");
    const role = masked.auth[0];
    assert.equal(role?.kind === "fields" && role.fields.password, "***");
    // The original is untouched.
    assert.equal(config.llm?.apiKey, ENV.FOUNDRY_API_KEY);
  });

  it("masks only the substituted part of a longer string", () => {
    const { config, secrets } = parse({ baseUrl: "https://${HOST}/app", seed: 1 }, { HOST: "internal.test" });
    assert.equal(maskSecrets(config, secrets).baseUrl, "https://***/app");
  });

  it("masks arbitrary text such as log lines", () => {
    const { secrets } = parse(fullConfig);
    assert.equal(secrets.mask(`login with ${SECRET} failed`), "login with *** failed");
  });

  it("never puts a secret value into error messages", () => {
    const env = { ...ENV, ENGINE: SECRET, URL: SECRET, NAME: SECRET };
    let message = "";
    try {
      parse(
        {
          ...fullConfig,
          baseUrl: "${URL}",
          browser: { engine: "${ENGINE}" },
          auth: [
            { name: "${NAME}", storageState: "a.json" },
            { name: "${NAME}", storageState: "b.json" },
          ],
          missing: "${ADMIN_PASS}",
        },
        env,
      );
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      message = `${error.message}\n${JSON.stringify(error.issues)}\n${error.stack}`;
    }
    assert.match(message, /browser\.engine: must be one of/);
    assert.match(message, /baseUrl: must be an absolute http\(s\) URL/);
    assert.match(message, /duplicate role name/);
    assert.ok(!message.includes(SECRET), message);
  });
});

describe("loadConfig", () => {
  it("resolves relative paths against the config file directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "monkey-config-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ baseUrl: "https://x.test", report: { dir: "./r" } }));
    const { config } = await loadConfig(file, { env: {} });
    assert.equal(config.report.dir, join(dir, "r"));
  });

  it("throws a ConfigError for a missing file", async () => {
    await assert.rejects(loadConfig("/nonexistent/config.json"), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /cannot read file \(ENOENT\)/);
      return true;
    });
  });
});

describe("monkey run with a config", () => {
  async function run(config: unknown, env: NodeJS.ProcessEnv) {
    const dir = await mkdtemp(join(tmpdir(), "monkey-cli-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify(config));
    let stdout = "";
    let stderr = "";
    const code = await runCli(["run", file], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env,
    });
    return { code, stdout, stderr };
  }

  it("exits 2 with the path and variable name for an unset env var, without any secret", async () => {
    const { code, stdout, stderr } = await run(fullConfig, { ADMIN_USER: "admin", FOUNDRY_API_KEY: "k" });
    assert.equal(code, 2);
    assert.match(stderr, /auth\[0\]\.fields\.password: environment variable ADMIN_PASS is not set/);
    assert.equal(stdout, "");
  });

  it("exits 2 on a missing config file", async () => {
    let stderr = "";
    const code = await runCli(["run", "/nonexistent/config.json"], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    assert.equal(code, 2);
    assert.match(stderr, /cannot read file/);
  });
});
