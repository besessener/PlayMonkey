import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Cookie, Locator, Page, Request } from "playwright";
import type { AuthRole, Config, FieldsLoginRole, StorageStateRole } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";
import { UrlScope } from "../monkey/scope.ts";

/** Role name used when the config has no `auth` entries. */
export const ANONYMOUS_ROLE = "anonymous";

export const DEFAULT_LOGIN_TIMEOUT_MS = 15_000;

/** Something worth reporting that is not a finding. */
export interface SessionEvent {
  kind: "blocked-navigation";
  url: string;
  time: string;
}

export interface SessionOptions {
  config: Config;
  secrets: Secrets;
  /** Directory for this role's trace and video; created by Playwright as needed. */
  outputDir: string;
  /** Record a Playwright trace (`trace.zip`). Default true. */
  trace?: boolean;
  /** Record a video of the page. Default true. */
  video?: boolean;
  loginTimeoutMs?: number;
}

export interface SessionArtifacts {
  tracePath?: string;
  videoPaths: string[];
}

export interface RoleSession {
  role: string;
  context: BrowserContext;
  page: Page;
  /** Info events such as blocked off-domain navigations, in order. */
  events: SessionEvent[];
  /** Stops tracing and closes the context, which writes the video; the context is closed even when this throws. */
  close(): Promise<SessionArtifacts>;
}

/** The role could not be set up. Maps to exit code 2. The message never contains secret values. */
export class LoginError extends Error {
  readonly role: string;

  constructor(role: string, reason: string) {
    super(`role "${role}": ${reason}`);
    this.name = "LoginError";
    this.role = role;
  }
}

/**
 * Opens an isolated browser context for one role (or an anonymous one when `role` is undefined), logged in, with
 * tracing, video and the stayOnDomain guard. Each call creates a new context, so cookies and storage never leak
 * between roles.
 */
export async function openRoleSession(
  browser: Browser,
  role: AuthRole | undefined,
  options: SessionOptions,
): Promise<RoleSession> {
  const { config, secrets } = options;
  const name = role?.name ?? ANONYMOUS_ROLE;
  const fail = (reason: string) => new LoginError(secrets.mask(name), secrets.mask(reason));

  let storageState: BrowserContextOptions["storageState"];
  if (role?.kind === "fields") {
    storageState = await loginWithFields(browser, role, options, fail);
  } else if (role?.kind === "storageState") {
    storageState = await readStorageState(role, fail);
  }

  const [width, height] = config.browser.viewport;
  const scope = new UrlScope(config.scope);
  const guarded = config.stayOnDomain || scope.restricted;
  const context = await browser.newContext({
    baseURL: config.baseUrl,
    viewport: { width, height },
    ...(storageState === undefined ? {} : { storageState }),
    ...(options.video === false
      ? {}
      : { recordVideo: { dir: join(options.outputDir, "video"), size: { width, height } } }),
    // Service workers bypass request routing, so they would undermine stayOnDomain, scope and the latency.
    ...(guarded || config.network.latencyMs > 0 ? { serviceWorkers: "block" as const } : {}),
  });
  const events: SessionEvent[] = [];
  let page: Page;
  try {
    page = await prepareContext(context, { options, scope, guarded, events });
  } catch (error) {
    // The setup error is the one worth reporting; a failed close must not replace it.
    await context.close().catch(() => undefined);
    throw error;
  }
  const tracePath = options.trace === false ? undefined : join(options.outputDir, "trace.zip");
  return { role: name, context, page, events, close: () => closeContext(context, tracePath) };
}

/** What `prepareContext` needs besides the context. */
interface ContextSetup {
  options: SessionOptions;
  scope: UrlScope;
  /** stayOnDomain or a restricted scope: navigations are checked. */
  guarded: boolean;
  events: SessionEvent[];
}

/** Adds the latency, the navigation guard and tracing to a new context and opens its first page. */
async function prepareContext(context: BrowserContext, { options, scope, guarded, events }: ContextSetup) {
  const { config, secrets } = options;
  const { latencyMs } = config.network;
  // Routes run newest first: the guard below aborts blocked navigations before they are delayed.
  if (latencyMs > 0) {
    await context.route("**/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      // The context may have closed during the delay; then nobody waits for the request any more.
      await route.fallback().catch(() => undefined);
    });
  }
  if (guarded) {
    const origin = config.stayOnDomain ? new URL(config.baseUrl).origin : undefined;
    const allowed = (url: string) => (origin === undefined || new URL(url).origin === origin) && scope.allows(url);
    await guardNavigations(context, allowed, events, secrets);
  }
  if (options.trace !== false) await context.tracing.start({ screenshots: true, snapshots: true });
  return await context.newPage();
}

/** Stops tracing into `tracePath`, if given, and closes the context, which writes the videos, even if tracing fails. */
async function closeContext(context: BrowserContext, tracePath: string | undefined): Promise<SessionArtifacts> {
  const videos = context.pages().flatMap((page) => page.video() ?? []);
  try {
    if (tracePath !== undefined) await context.tracing.stop({ path: tracePath });
  } finally {
    await context.close();
  }
  const videoPaths = await Promise.all(videos.map((video) => video.path()));
  return { ...(tracePath === undefined ? {} : { tracePath }), videoPaths };
}

/**
 * Logs in through the form in a throwaway context (no trace or video, so typed secrets are not recorded) and
 * returns the resulting storage state. Success means the page left the login URL, or a cookie changed and the
 * submit button is gone (single-page apps that log in without navigating).
 */
async function loginWithFields(
  browser: Browser,
  role: FieldsLoginRole,
  options: SessionOptions,
  fail: (reason: string) => LoginError,
): Promise<NonNullable<BrowserContextOptions["storageState"]>> {
  const { config } = options;
  const timeout = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const [width, height] = config.browser.viewport;
  const context = await browser.newContext({ baseURL: config.baseUrl, viewport: { width, height } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    try {
      await page.goto(new URL(role.loginUrl, config.baseUrl).href);
    } catch {
      throw fail(`cannot open the login page ${role.loginUrl}`);
    }
    // Compare against where the browser landed, in case the configured login URL redirects.
    const loginUrl = new URL(page.url());

    for (const [field, value] of Object.entries(role.fields)) {
      const locator = await findField(page, field);
      if (locator === undefined) throw fail(`login field "${field}" not found on ${role.loginUrl}`);
      try {
        await locator.fill(value);
      } catch {
        throw fail(`cannot fill login field "${field}"`);
      }
    }

    const submit = page.locator(role.submit);
    if ((await submit.count()) !== 1) throw fail(`submit selector "${role.submit}" must match exactly one element`);
    const cookiesBefore = fingerprint(await context.cookies());
    const onLoginPage = (url: URL) => url.origin === loginUrl.origin && url.pathname === loginUrl.pathname;

    // Settles on whichever comes first: the URL leaves the login page, the next document loads (a re-rendered
    // login page after a failed attempt), or the timeout (no navigation at all).
    const settled = Promise.race([
      page.waitForURL((url) => !onLoginPage(url), { timeout, waitUntil: "load" }),
      page.waitForEvent("load", { timeout }),
    ]).catch(() => undefined);
    try {
      await submit.click();
    } catch {
      throw fail(`cannot click the submit button "${role.submit}"`);
    }
    await settled;

    const leftLoginPage = !onLoginPage(new URL(page.url()));
    const cookieChanged = fingerprint(await context.cookies()) !== cookiesBefore;
    const formGone = !(await submit.isVisible().catch(() => false));
    if (!(leftLoginPage || (cookieChanged && formGone))) {
      throw fail(
        `login did not succeed: still on ${role.loginUrl} after submitting (check the credentials and the fields)`,
      );
    }
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/**
 * Finds a login field by key: a CSS selector if the key looks like one, otherwise the `name` attribute, then the
 * `id`, then the accessible label. The first strategy that matches exactly one element wins.
 */
async function findField(page: Page, key: string): Promise<Locator | undefined> {
  const candidates = /[#.[\]:>\s=*~+]/.test(key)
    ? [page.locator(key)]
    : [
        page.locator(`[name="${cssString(key)}"]`),
        page.locator(`[id="${cssString(key)}"]`),
        page.getByLabel(key, { exact: true }),
      ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 1) return candidate;
  }
  return undefined;
}

async function readStorageState(
  role: StorageStateRole,
  fail: (reason: string) => LoginError,
): Promise<NonNullable<BrowserContextOptions["storageState"]>> {
  let text: string;
  try {
    text = await readFile(role.storageState, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw fail(`cannot read storageState file ${role.storageState} (${code})`);
  }
  try {
    const state = JSON.parse(text) as unknown;
    if (state === null || typeof state !== "object" || !Array.isArray((state as { cookies?: unknown }).cookies)) {
      throw new Error("missing cookies array");
    }
    return state as NonNullable<Exclude<BrowserContextOptions["storageState"], string>>;
  } catch {
    throw fail(`storageState file ${role.storageState} is not a Playwright storage state (JSON with "cookies")`);
  }
}

/**
 * Blocks top-level navigations to URLs that are not `allowed` (other origins, out of scope) and records them;
 * subresources (CDNs, fonts) and fetches are allowed. The request is aborted as `aborted` (net::ERR_ABORTED), which
 * keeps the current page; other error codes would show the browser's error page, and answering 204 leaves
 * Playwright's click waiting for the navigation.
 */
async function guardNavigations(
  context: BrowserContext,
  allowed: (url: string) => boolean,
  events: SessionEvent[],
  secrets: Secrets,
) {
  await context.route("**/*", async (route, request) => {
    const isTopLevel = request.isNavigationRequest() && isMainFrame(request);
    if (isTopLevel && !allowed(request.url())) {
      events.push({ kind: "blocked-navigation", url: secrets.mask(request.url()), time: new Date().toISOString() });
      await route.abort("aborted");
      return;
    }
    await route.fallback();
  });
}

/**
 * True for a request of a page's main frame. The first navigation of a popup has no frame yet (`request.frame()`
 * throws); it is the popup's main frame.
 */
function isMainFrame(request: Request): boolean {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return true;
  }
}

function fingerprint(cookies: Cookie[]): string {
  return cookies
    .map((cookie) => `${cookie.domain}\t${cookie.path}\t${cookie.name}\t${cookie.value}`)
    .sort()
    .join("\n");
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
