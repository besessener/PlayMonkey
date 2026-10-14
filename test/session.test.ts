import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { FIXTURE_CREDENTIALS, type Fixture, startFixture } from "../fixtures/site/server.ts";
import { ANONYMOUS_ROLE, LoginError, openRoleSession, type RoleSession } from "../src/auth/session.ts";
import { type LoadedConfig, parseConfig } from "../src/config/config.ts";
import { launchChromium } from "./helpers/browser.ts";
import { readZipEntries } from "./helpers/zip.ts";

const PASSWORD_ENV = { FIXTURE_USER: FIXTURE_CREDENTIALS.username, FIXTURE_PASS: FIXTURE_CREDENTIALS.password };

describe("role sessions against the fixture site", () => {
  let site: Fixture;
  let external: Fixture;
  let browser: Browser;
  let outputRoot: string;
  const open: RoleSession[] = [];

  before(async () => {
    site = await startFixture();
    external = await startFixture(); // a different port is a different origin
    browser = await launchChromium();
    outputRoot = await mkdtemp(join(tmpdir(), "monkey-session-"));
  });
  after(async () => {
    for (const session of open) await session.close().catch(() => {});
    await browser?.close();
    await site?.close();
    await external?.close();
  });

  function load(auth: unknown[], extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = PASSWORD_ENV) {
    return parseConfig(JSON.stringify({ baseUrl: site.url, seed: 1, auth, ...extra }), { env, baseDir: outputRoot });
  }

  const fieldsRole = (name = "user", password = "${FIXTURE_PASS}") => ({
    name,
    loginUrl: "/login",
    fields: { username: "${FIXTURE_USER}", password },
    submit: "button[type=submit]",
  });

  async function openSession(loaded: LoadedConfig, index: number | undefined, extra = {}) {
    const role = index === undefined ? undefined : loaded.config.auth[index];
    const session = await openRoleSession(browser, role, {
      config: loaded.config,
      secrets: loaded.secrets,
      outputDir: join(outputRoot, role?.name ?? ANONYMOUS_ROLE),
      loginTimeoutMs: 5000,
      ...extra,
    });
    open.push(session);
    return session;
  }

  async function signedIn(session: RoleSession): Promise<boolean> {
    await session.page.goto("/account");
    return new URL(session.page.url()).pathname === "/account";
  }

  async function errorOf(promise: Promise<unknown>): Promise<LoginError> {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof LoginError, `expected LoginError, got ${String(error)}`);
      return error;
    }
    assert.fail("expected a LoginError");
  }

  it("logs in with fields and ends on /account", async () => {
    const session = await openSession(load([fieldsRole()]), 0);
    assert.equal(session.role, "user");
    assert.equal(await signedIn(session), true);
    assert.match((await session.page.locator("main").textContent()) ?? "", /Signed in as monkey/);
  });

  it("reuses a storageState file without any login request", async () => {
    const stateFile = join(outputRoot, "user-state.json");
    const loginSession = await openSession(load([fieldsRole()]), 0, { trace: false, video: false });
    await loginSession.context.storageState({ path: stateFile });

    const session = await openSession(load([{ name: "saved", storageState: stateFile }]), 0);
    const loginRequests: string[] = [];
    session.context.on("request", (request) => {
      if (new URL(request.url()).pathname === "/login") loginRequests.push(request.method());
    });
    assert.equal(await signedIn(session), true);
    assert.deepEqual(loginRequests, []);
  });

  it("keeps roles in independent contexts", async () => {
    const loaded = load([fieldsRole("admin"), { name: "guest", storageState: join(outputRoot, "empty.json") }]);
    await writeFile(join(outputRoot, "empty.json"), JSON.stringify({ cookies: [], origins: [] }));
    const admin = await openSession(loaded, 0);
    const guest = await openSession(loaded, 1);
    const anonymous = await openSession(loaded, undefined);

    assert.notEqual(admin.context, guest.context);
    assert.equal(await signedIn(admin), true);
    assert.equal(await signedIn(guest), false);
    assert.equal(await signedIn(anonymous), false);
    assert.equal(anonymous.role, ANONYMOUS_ROLE);
    assert.ok((await admin.context.cookies()).some((cookie) => cookie.name === "sid"));
    assert.deepEqual(await guest.context.cookies(), []);
  });

  it("fails a wrong password with a LoginError that does not contain the password", async () => {
    const wrong = "Wr0ng-Passw0rd!";
    const loaded = load([fieldsRole("user", "${WRONG_PASS}")], {}, { ...PASSWORD_ENV, WRONG_PASS: wrong });
    const started = Date.now();
    const error = await errorOf(openSession(loaded, 0));
    assert.match(error.message, /role "user": login did not succeed/);
    assert.ok(!`${error.message}\n${error.stack}`.includes(wrong));
    // The re-rendered login page settles the attempt; it must not wait for the timeout.
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
  });

  it("fails clearly when a login field does not exist", async () => {
    const role = { ...fieldsRole(), fields: { username: "${FIXTURE_USER}", otp: "123" } };
    const error = await errorOf(openSession(load([role]), 0));
    assert.match(error.message, /login field "otp" not found on \/login/);
  });

  it("finds fields by CSS selector and by label", async () => {
    const role = {
      ...fieldsRole(),
      fields: { "input[name=username]": "${FIXTURE_USER}", Password: "${FIXTURE_PASS}" },
    };
    assert.equal(await signedIn(await openSession(load([role]), 0)), true);
  });

  it("fails clearly when the storageState file is missing or invalid", async () => {
    const missing = await errorOf(openSession(load([{ name: "u", storageState: "nope.json" }]), 0));
    assert.match(missing.message, /cannot read storageState file .*nope\.json \(ENOENT\)/);

    await writeFile(join(outputRoot, "bad.json"), "{}");
    const invalid = await errorOf(openSession(load([{ name: "u", storageState: "bad.json" }]), 0));
    assert.match(invalid.message, /is not a Playwright storage state/);
  });

  async function clickExternalLink(session: RoleSession) {
    await session.page.goto("/clean");
    await session.page.evaluate((href) => {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = "Leave";
      document.body.append(link);
    }, `${external.url}/clean`);
    await session.page.getByRole("link", { name: "Leave" }).click();
    await session.page.waitForLoadState();
  }

  it("does not follow a link to another origin with stayOnDomain", async () => {
    const session = await openSession(load([]), undefined);
    await clickExternalLink(session);
    assert.equal(new URL(session.page.url()).origin, site.url);
    assert.equal(session.events.length, 1);
    assert.equal(session.events[0]?.kind, "blocked-navigation");
    assert.equal(session.events[0]?.url, `${external.url}/clean`);
  });

  it("follows a link to another origin without stayOnDomain", async () => {
    const session = await openSession(load([], { stayOnDomain: false }), undefined);
    await clickExternalLink(session);
    await session.page.waitForURL(`${external.url}/clean`);
    assert.deepEqual(session.events, []);
  });

  it("writes a trace and a video on close, without the login secrets in the trace", async () => {
    const loaded = load([fieldsRole("recorded")]);
    const session = await openSession(loaded, 0);
    await session.page.goto("/account");
    open.splice(open.indexOf(session), 1);
    const artifacts = await session.close();

    assert.ok(artifacts.tracePath);
    assert.ok((await stat(artifacts.tracePath)).size > 0);
    assert.equal(artifacts.videoPaths.length, 1);
    assert.ok((await stat(artifacts.videoPaths[0] ?? "")).size > 0);
    // The login runs in a separate, unrecorded context, so the typed password never reaches the trace.
    const entries = readZipEntries(await readFile(artifacts.tracePath));
    assert.ok(
      [...entries.keys()].some((name) => name.endsWith(".trace")),
      "trace has events",
    );
    assert.ok(
      [...entries.values()].some((data) => data.includes("/account")),
      "trace mentions the visited page",
    );
    for (const [name, data] of entries) {
      assert.equal(data.includes(FIXTURE_CREDENTIALS.password), false, `password found in trace entry ${name}`);
    }
  });

  it("closes the context even when stopping the trace fails", async () => {
    const session = await openSession(load([]), undefined, { video: false });
    open.splice(open.indexOf(session), 1);
    session.context.tracing.stop = () => Promise.reject(new Error("ENOSPC: no space left on device"));
    await assert.rejects(session.close(), /ENOSPC/);
    assert.equal(browser.contexts().includes(session.context), false);
  });

  it("closes the context when the session cannot be set up", async () => {
    const created: BrowserContext[] = [];
    const failing = {
      newContext: async (contextOptions: BrowserContextOptions) => {
        const context = await browser.newContext(contextOptions);
        context.newPage = () => Promise.reject(new Error("cannot open a page"));
        created.push(context);
        return context;
      },
    } as Browser;
    const loaded = load([]);
    const options = { config: loaded.config, secrets: loaded.secrets, outputDir: outputRoot, video: false };
    await assert.rejects(openRoleSession(failing, undefined, options), /cannot open a page/);
    assert.equal(created.length, 1);
    assert.equal(browser.contexts().includes(created[0] as BrowserContext), false);
  });
});
