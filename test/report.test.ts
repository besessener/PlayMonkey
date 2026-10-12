import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { runCli } from "../src/cli/cli.ts";
import { parseConfig } from "../src/config/config.ts";
import type { Finding } from "../src/oracles/finding.ts";
import { renderHtml } from "../src/report/html.ts";
import { buildReport, type Report } from "../src/report/report.ts";
import type { RoleOutcome } from "../src/run.ts";
import { launchChromium } from "./helpers/browser.ts";

/** Login and test data that occur nowhere else, so a grep for them is meaningful. */
const CREDENTIALS = { username: "agent-7c1f", password: "Pa55-wrd-93kq" };
const SECRET_EMAIL = "secret-inbox-41@example.test";

function finding(
  id: string,
  severity: Finding["severity"],
  occurrences: number,
  extra: Partial<Finding> = {},
): Finding {
  return {
    id,
    oracle: "console",
    severity,
    key: `console|${id}`,
    message: `message ${id}`,
    url: "https://test.example.org/page",
    step: 3,
    role: "user",
    occurrences,
    details: {},
    lastActions: [],
    ...extra,
  };
}

function outcome(findings: Finding[]): RoleOutcome {
  return {
    role: "user",
    seed: 5,
    result: { steps: 10, stopReason: "maxSteps", durationMs: 1200, states: 4, failedActions: 0, skippedActions: 0 },
    findings,
    blockedNavigations: 0,
  };
}

describe("report", () => {
  const loaded = parseConfig(
    JSON.stringify({ baseUrl: "https://test.example.org", seed: 5, testData: { pin: "${PIN}" } }),
    { env: { PIN: "secret-pin-8812" }, baseDir: "/reports" },
  );
  const build = (findings: Finding[]) =>
    buildReport({
      loaded,
      outcomes: [outcome(findings)],
      version: "1.2.3",
      startedAt: new Date(0),
      finishedAt: new Date(1000),
    });

  it("sorts findings by severity, then occurrences, and counts them", () => {
    const report = build([
      finding("F1", "low", 9),
      finding("F2", "high", 1),
      finding("F3", "critical", 1),
      finding("F4", "high", 5),
      finding("F5", "medium", 2),
    ]);
    assert.deepEqual(
      report.findings.map((f) => f.id),
      ["F3", "F4", "F2", "F5", "F1"],
    );
    assert.deepEqual(report.counts, { critical: 1, high: 2, medium: 1, low: 1 });
    assert.equal(report.tool.version, "1.2.3");
    assert.equal(report.seed, 5);
    assert.deepEqual(report.roles[0], {
      role: "user",
      seed: 5,
      steps: 10,
      durationMs: 1200,
      stopReason: "maxSteps",
      states: 4,
      failedActions: 0,
      findings: 5,
      blockedNavigations: 0,
      videos: [],
    });
  });

  it("aggregates findings across runs by key, in run order", () => {
    const run = (role: string, seed: number, findings: Finding[]): RoleOutcome => ({
      ...outcome(findings.map((f) => ({ ...f, role }))),
      role,
      seed,
    });
    const report = buildReport({
      loaded,
      outcomes: [
        run("admin", 1, [finding("F1", "medium", 2), finding("F2", "low", 1)]),
        run("user", 1, [
          finding("F1", "low", 1, { key: "console|F2" }),
          finding("F2", "medium", 3, { key: "console|F1" }),
        ]),
        run("user", 2, [finding("F1", "high", 1, { key: "console|X" })]),
      ],
      version: "1.2.3",
      startedAt: new Date(0),
      finishedAt: new Date(1000),
    });
    assert.deepEqual(
      report.aggregated.map((f) => [
        f.key,
        f.severity,
        f.occurrences,
        f.roles,
        f.runs.map((r) => `${r.role}/${r.seed}/${r.id}`),
      ]),
      [
        ["console|X", "high", 1, ["user"], ["user/2/F1"]],
        ["console|F1", "medium", 5, ["admin", "user"], ["admin/1/F1", "user/1/F2"]],
        ["console|F2", "low", 2, ["admin", "user"], ["admin/1/F2", "user/1/F1"]],
      ],
    );
    assert.deepEqual(report.counts, { critical: 0, high: 1, medium: 1, low: 1 });
    assert.equal(report.findings.length, 5);
    assert.deepEqual(
      report.findings.map((f) => f.seed),
      [2, 1, 1, 1, 1],
    );
  });

  it("masks the config", () => {
    const report = build([]);
    assert.ok(!JSON.stringify(report).includes("secret-pin-8812"));
    assert.equal((report.config as { testData: { pin: string } }).testData.pin, "***");
  });

  it("escapes every dynamic value in the HTML and loads nothing from the network", () => {
    const evil = "<script>alert('x')</script>";
    const report = build([
      finding("F1", "high", 1, {
        message: evil,
        url: `https://test.example.org/?q="><img src=x onerror=alert(1)>`,
        details: { text: evil },
        lastActions: [
          {
            step: 3,
            action: { type: "fill", ref: "e1", value: evil },
            locator: `getByRole('textbox', { name: '"><b>x</b>' })`,
            url: "https://test.example.org/form",
          },
        ],
      }),
    ]);
    report.roles[0] = { ...(report.roles[0] as Report["roles"][number]), role: "<i>role</i>" };
    const html = renderHtml(report, new Map());
    assert.ok(!html.includes("<script"), "no script element at all");
    assert.ok(!html.includes("<img src=x"));
    assert.ok(!html.includes("<b>x</b>"));
    assert.ok(!html.includes("<i>role</i>"));
    assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
    assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//, "no external resources or links to them");
    assert.doesNotMatch(html, /<link (?!rel="icon" href="data:,")/);
  });

  it("renders repro steps in words with their durable locators", () => {
    const html = renderHtml(
      build([
        finding("F1", "high", 1, {
          step: 5,
          lastActions: [
            {
              step: 4,
              action: { type: "click", ref: "e2" },
              locator: "getByRole('link', { name: 'Form' })",
              url: "https://test.example.org/",
            },
            { step: 5, action: { type: "press", key: "Enter" }, url: "https://test.example.org/form" },
          ],
        }),
      ]),
      new Map(),
    );
    assert.match(
      html,
      /<ol start="4"><li>Click <code>getByRole\(&#39;link&#39;, \{ name: &#39;Form&#39; \}\)<\/code> <span class="on">on \/<\/span><\/li><li>Press <kbd>Enter<\/kbd>/,
    );
  });
});

describe("report of a run against the fixture site", () => {
  let site: Fixture;
  let dir: string;
  before(async () => {
    site = await startFixture({ credentials: CREDENTIALS });
    dir = await mkdtemp(join(tmpdir(), "playmonkey-report-"));
  });
  after(() => site?.close());

  it("lists the seeded findings, opens offline, and contains no secret value", async () => {
    const config = join(dir, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        baseUrl: "${SITE_URL}",
        seed: 42,
        limits: { maxSteps: 300 },
        auth: [
          {
            name: "user",
            loginUrl: "/login",
            fields: { username: "${SITE_USER}", password: "${SITE_PASS}" },
            submit: "button[type=submit]",
          },
        ],
        testData: { email: "${SECRET_EMAIL}", name: "Monkey" },
        report: { dir: "report" },
      }),
    );
    let stdout = "";
    const env = {
      SITE_URL: site.url,
      SITE_USER: CREDENTIALS.username,
      SITE_PASS: CREDENTIALS.password,
      SECRET_EMAIL,
    };
    const code = await runCli(["run", config], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      env,
    });
    assert.equal(code, 1, stdout);
    const reportDir = join(dir, "report");
    assert.match(stdout, /\nreport: .*report\.html\nexit 1: findings present\n$/);

    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as Report;
    const oracles = report.findings.map((f) => f.oracle).sort();
    assert.deepEqual(oracles, ["console", "http4xx", "http5xx", "overflow", "pageerror"]);
    assert.deepEqual(
      report.findings.map((f) => f.severity),
      ["high", "high", "medium", "medium", "low"],
    );
    assert.equal(report.roles[0]?.trace, "user/trace.zip");
    assert.equal(report.roles[0]?.actionLog, "user/actions.json");
    assert.ok(report.findings.every((f) => f.screenshot?.startsWith("user/screenshots/")));

    // Every text file in the report directory, the HTML with its embedded screenshots included.
    const secrets = [CREDENTIALS.username, CREDENTIALS.password, SECRET_EMAIL, site.url, new URL(site.url).host];
    const files = (await readdir(reportDir, { recursive: true })).filter((file) =>
      [".json", ".html"].includes(extname(file)),
    );
    assert.ok(files.length >= 3, files.join(", "));
    for (const file of files) {
      const text = await readFile(join(reportDir, file), "utf8");
      for (const secret of secrets) assert.ok(!text.includes(secret), `${file} contains ${secret}`);
    }

    const browser = await launchChromium();
    try {
      const context = await browser.newContext({ offline: true });
      const page = await context.newPage();
      const failed: string[] = [];
      page.on("requestfailed", (request) => failed.push(request.url()));
      await page.goto(`file://${join(reportDir, "report.html")}`);
      assert.equal(await page.locator("article.finding").count(), 5);
      assert.equal(await page.locator("img.shot").count(), 5);
      // The embedded screenshot decodes, so it really is in the file.
      await page.waitForFunction("document.querySelector('img.shot').naturalWidth > 0", undefined, { timeout: 5000 });
      assert.deepEqual(failed, []);
    } finally {
      await browser.close();
    }
  });
});
