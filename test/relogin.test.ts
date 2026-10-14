import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { MAX_FAILED_RELOGINS, SessionKeeper } from "../src/auth/relogin.ts";
import type { SessionEvent } from "../src/auth/session.ts";
import { parseConfig } from "../src/config/config.ts";
import type { StepRecord } from "../src/monkey/loop.ts";
import { runRole } from "../src/run.ts";
import type { Snapshot, SnapshotElement } from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";
import { button, click, step } from "./helpers/drive.ts";

const SECRET = "s3cret-token";
const BASE = "https://test.example.org";

const element = (role: string, name: string): SnapshotElement => ({
  ref: "e1",
  role,
  name,
  enabled: true,
  inViewport: true,
  inFrame: false,
});

function snap(path: string, elements: SnapshotElement[] = []): Snapshot {
  return { url: `${BASE}${path}`, title: "", elements, text: "", crossOriginFrames: 0, dialogs: [], hash: "h" };
}

const home = snap("/");
const signIn = snap(`/signin?token=${SECRET}`, [element("textbox", "Password"), element("button", "Sign in")]);

/** A keeper with a fake re-login that fails while `failing` is true. */
function keeper(failing = false) {
  const role = { name: "u", loginUrl: "/login", fields: { password: "${PASS}" }, submit: "button" };
  const { secrets } = parseConfig(JSON.stringify({ baseUrl: BASE, auth: [role] }), { env: { PASS: SECRET } });
  const events: SessionEvent[] = [];
  const lines: string[] = [];
  const state = { failing, relogins: 0 };
  const instance = new SessionKeeper({
    relogin: () => {
      state.relogins++;
      return state.failing ? Promise.reject(new Error(`cannot read ${SECRET}`)) : Promise.resolve();
    },
    events,
    secrets,
    baseUrl: BASE,
    loginUrl: `${BASE}/login`,
    navigationTimeoutMs: 1000,
    log: (line) => lines.push(line),
  });
  return { keeper: instance, events, lines, state };
}

describe("session keeper", () => {
  it("records a lost session once per arrival on a login page and logs in again", async () => {
    const { keeper: k, events, lines, state } = keeper();
    await k.check(home, undefined);
    await k.check(snap("/login?next=/"), undefined);
    await k.check(home, undefined);
    await k.check(signIn, undefined);
    assert.equal(state.relogins, 2);
    assert.deepEqual(
      events.map((e) => [e.kind, e.url]),
      [
        ["session-lost", `${BASE}/login?next=/`],
        ["session-lost", `${BASE}/signin?token=***`],
      ],
    );
    assert.deepEqual(lines.slice(2), [
      `warning: session lost, ${BASE}/signin?token=*** is a login page`,
      "logged in again",
    ]);
  });

  it(`gives up after ${MAX_FAILED_RELOGINS} failed re-logins in a row and never logs a secret`, async () => {
    const { keeper: k, events, lines, state } = keeper(true);
    for (let i = 0; i < 6; i++) await k.check(signIn, undefined);
    assert.equal(state.relogins, MAX_FAILED_RELOGINS);
    assert.equal(events.length, 1);
    assert.deepEqual(lines, [
      `warning: session lost, ${BASE}/signin?token=*** is a login page`,
      "logging in again failed: cannot read ***",
      "logging in again failed: cannot read ***",
      "logging in again failed: cannot read ***",
      "not logging in again after 3 failed attempts; the run goes on logged out",
    ]);
  });

  it("counts a re-login that leaves the role on a login page as failed, and one that helps as a fresh start", async () => {
    const { keeper: k, events, state } = keeper();
    await k.check(signIn, undefined);
    await k.check(signIn, undefined);
    await k.check(home, undefined);
    state.relogins = 0;
    for (let i = 0; i < 5; i++) await k.check(signIn, undefined);
    assert.equal(state.relogins, MAX_FAILED_RELOGINS);
    assert.equal(events.length, 2);
  });
});

describe("a role that loses its session during a run", () => {
  let site: Fixture;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixture();
    browser = await launchChromium();
    dir = await mkdtemp(join(tmpdir(), "monkey-relogin-"));
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  it("logs in again after the monkey logged out, and goes on logged in", async () => {
    const role = {
      name: "user",
      loginUrl: "/login",
      fields: { username: "${U}", password: "${P}" },
      submit: "button[type=submit]",
    };
    const loaded = parseConfig(
      JSON.stringify({ baseUrl: site.url, seed: 1, monkey: { actionTimeoutMs: 2000 }, auth: [role] }),
      { env: { U: FIXTURE_CREDENTIALS.username, P: FIXTURE_CREDENTIALS.password } },
    );
    const records: StepRecord[] = [];
    const lines: string[] = [];
    const account = step({ type: "navigate", url: `${site.url}/account` });
    const outcome = await runRole(browser, loaded.config.auth[0], loaded, {
      log: (line) => lines.push(line),
      outputDir: join(dir, "user"),
      actionLog: false,
      artifacts: false,
      // Log out, get sent to /login by /account, take one step there, then open /account again.
      replay: {
        strict: true,
        actions: [account, click(button("Log out")), account, step({ type: "scroll", deltaY: 100 }), account],
      },
      onStep: (record) => {
        records.push(record);
      },
    });
    assert.equal(outcome.result?.stopReason, "end", outcome.result?.error ?? lines.join("\n"));
    assert.deepEqual(
      records.map((r) => [new URL(r.url).pathname, new URL(r.result.url).pathname]),
      [
        ["/", "/account"],
        ["/account", "/"],
        ["/", "/login"],
        ["/login", "/login"],
        ["/", "/account"],
      ],
    );
    assert.equal(outcome.sessionLosses, 1);
    assert.equal(outcome.blockedNavigations, 0);
    assert.ok(lines.includes(`[user] warning: session lost, ${site.url}/login is a login page`), lines.join("\n"));
    assert.ok(lines.includes("[user] logged in again"));
    assert.ok(lines.includes("[user] session lost 1 time"));
    assert.ok(!lines.join("\n").includes(FIXTURE_CREDENTIALS.password));
  });
});
