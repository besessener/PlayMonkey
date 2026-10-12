import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { type Fixture, startFixture } from "../fixtures/site/server.ts";
import { serializeSnapshot } from "../src/snapshot/serialize.ts";
import {
  durableLocator,
  resolve,
  type Snapshot,
  type SnapshotElement,
  StaleRefError,
  snapshot,
} from "../src/snapshot/snapshot.ts";
import { launchChromium } from "./helpers/browser.ts";

const PAGES = ["/", "/login", "/form", "/js-error", "/console-error", "/overflow", "/clean"];

const summary = (elements: SnapshotElement[]) => elements.map((element) => `${element.role} ${element.name}`);

describe("page snapshot against the fixture site", () => {
  let site: Fixture;
  let external: Fixture;
  let browser: Browser;
  let page: Page;

  before(async () => {
    site = await startFixture();
    external = await startFixture();
    browser = await launchChromium();
  });
  after(async () => {
    await browser?.close();
    await site?.close();
    await external?.close();
  });

  async function open(path: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(site.url + path);
    return page;
  }

  it("records open dialogs by name, and none on ordinary pages", async () => {
    for (const path of PAGES) assert.deepEqual((await snapshot(await open(path))).dialogs, [], path);
    const p = await open("/clean");
    await p.setContent(`<dialog open aria-label="Cookies"><p>We use cookies.</p><button>Accept</button></dialog>
      <div role="alertdialog"><button>OK</button></div><dialog aria-label="Closed"></dialog>`);
    const snap = await snapshot(p);
    assert.deepEqual(snap.dialogs, ["Cookies", ""]);
    assert.match(serializeSnapshot(snap), /^Open dialogs: "Cookies", ""$/m);
  });

  it("lists the interactive elements of the form", async () => {
    const snap = await snapshot(await open("/form"));
    assert.equal(snap.url, `${site.url}/form`);
    assert.equal(snap.title, "Contact form");
    assert.deepEqual(summary(snap.elements), [
      "link Home",
      "textbox Name",
      "textbox Email",
      "combobox Topic",
      "checkbox Subscribe to the newsletter",
      "textbox Message",
      "button Send",
    ]);
    const topic = snap.elements.find((element) => element.role === "combobox");
    assert.deepEqual(topic?.options, ["Question", "Bug report", "Other"]);
    assert.equal(snap.elements.find((element) => element.role === "checkbox")?.checked, false);
    assert.ok(snap.elements.every((element) => element.enabled && element.inViewport && !element.inFrame));
    assert.match(snap.text, /Contact form/);
  });

  it("lists every link of the home page with its target", async () => {
    const snap = await snapshot(await open("/"));
    const links = snap.elements.filter((element) => element.role === "link").map((link) => `${link.name} ${link.url}`);
    assert.ok(links.includes("Broken link /missing-page"));
    assert.ok(links.includes("Contact form /form"));
    assert.equal(links.length, 9);
  });

  for (const path of PAGES) {
    it(`resolves every ref on ${path} to the element it describes`, async () => {
      const p = await open(path);
      const first = await snapshot(p);
      assert.ok(first.elements.length > 0);
      for (const [index, original] of first.elements.entries()) {
        // locator.ariaSnapshot() below replaces the refs, so snapshot again; refs of an element stay the same.
        const element = (await snapshot(p)).elements[index];
        assert.equal(element?.ref, original.ref);
        if (element === undefined) continue;
        const locator = await resolve(p, element.ref);
        const aria = await locator.ariaSnapshot();
        const expected =
          element.name === "" ? `- ${element.role}` : `- ${element.role} ${JSON.stringify(element.name)}`;
        assert.ok(aria.startsWith(expected), `${element.ref}: expected ${expected}, got ${aria.split("\n")[0]}`);
      }
    });
  }

  it("fills and clicks through refs", async () => {
    const p = await open("/form");
    const snap = await snapshot(p);
    for (const element of snap.elements.filter((e) => e.role === "textbox")) {
      await (await resolve(p, element.ref)).fill(`value for ${element.name}`);
    }
    assert.equal(await p.getByLabel("Message").inputValue(), "value for Message");
    const checkbox = snap.elements.find((element) => element.role === "checkbox");
    await (await resolve(p, checkbox?.ref ?? "")).check();
    assert.equal((await snapshot(p)).elements.find((element) => element.role === "checkbox")?.checked, true);
  });

  it("keeps the hash for an unchanged page and changes it after a state change", async () => {
    const p = await open("/clean");
    const first = await snapshot(p);
    const second = await snapshot(p);
    assert.equal(first.hash, second.hash);

    const reloaded = await snapshot(await open("/clean"));
    assert.equal(reloaded.hash, first.hash, "stable across page loads");

    const toggle = first.elements.find((element) => element.name === "Show details");
    await (await resolve(page, toggle?.ref ?? "")).click();
    const toggled = await snapshot(page);
    assert.notEqual(toggled.hash, first.hash);
    assert.match(toggled.text, /Nothing to see here/);

    const other = await snapshot(await open("/form"));
    assert.notEqual(other.hash, first.hash);
  });

  it("rejects a ref from an earlier page at once", async () => {
    const p = await open("/form");
    const old = await snapshot(p);
    await p.goto(`${site.url}/clean`);
    await snapshot(p);
    const send = old.elements.find((element) => element.name === "Send")?.ref ?? "";
    const started = Date.now();
    await assert.rejects(resolve(p, send), StaleRefError);
    assert.ok(Date.now() - started < 1000);
  });

  it("gives a durable locator for the action log", async () => {
    const p = await open("/form");
    const snap = await snapshot(p);
    const send = snap.elements.find((element) => element.name === "Send")?.ref ?? "";
    assert.equal(await durableLocator(p, send), "getByRole('button', { name: 'Send' })");
  });

  it("includes open shadow DOM and same-origin iframes, but not cross-origin iframes", async () => {
    const p = await open("/clean");
    await p.evaluate((externalUrl) => {
      const host = document.createElement("div");
      document.body.append(host);
      host.attachShadow({ mode: "open" }).innerHTML =
        "<button onclick=\"this.textContent='Shadow clicked'\">Shadow button</button>";
      const same = document.createElement("iframe");
      same.srcdoc = "<button onclick=\"this.textContent='Frame clicked'\">Frame button</button>";
      const cross = document.createElement("iframe");
      cross.src = `${externalUrl}/clean`;
      document.body.append(same, cross);
    }, external.url);
    await p.frameLocator("iframe >> nth=1").getByRole("button", { name: "Show details" }).waitFor();

    const snap = await snapshot(p);
    assert.equal(snap.crossOriginFrames, 1);
    assert.equal(snap.elements.filter((element) => element.name === "Show details").length, 1);

    const shadow = snap.elements.find((element) => element.name === "Shadow button");
    const framed = snap.elements.find((element) => element.name === "Frame button");
    assert.equal(shadow?.inFrame, false);
    assert.equal(framed?.inFrame, true);
    await (await resolve(p, shadow?.ref ?? "")).click();
    await (await resolve(p, framed?.ref ?? "")).click();
    const names = summary((await snapshot(p)).elements);
    assert.ok(names.includes("button Shadow clicked"));
    assert.ok(names.includes("button Frame clicked"));
  });

  it("marks elements outside the viewport", async () => {
    const p = await open("/clean");
    await p.evaluate(() => {
      for (let i = 0; i < 100; i++) {
        const button = document.createElement("button");
        button.textContent = `Button ${i}`;
        button.style.display = "block";
        button.style.height = "50px";
        document.body.append(button);
      }
    });
    const snap = await snapshot(p);
    assert.equal(snap.elements.find((element) => element.name === "Button 0")?.inViewport, true);
    assert.equal(snap.elements.find((element) => element.name === "Button 99")?.inViewport, false);
  });
});

describe("serializeSnapshot", () => {
  const element = (i: number, inViewport: boolean): SnapshotElement => ({
    ref: `e${i}`,
    role: "button",
    name: `Button number ${i} ${"x".repeat(i % 7 === 0 ? 500 : 5)}`,
    enabled: true,
    inViewport,
    inFrame: false,
  });

  const large: Snapshot = {
    url: "https://test.example.org/big",
    title: "Big page",
    elements: Array.from({ length: 5000 }, (_, i) => element(i, i >= 4900)),
    text: "lorem ipsum ".repeat(5000),
    crossOriginFrames: 2,
    dialogs: [],
    hash: "0".repeat(16),
  };

  for (const maxChars of [500, 2000, 8000, 20_000]) {
    it(`stays within ${maxChars} characters on a large page and says what it left out`, () => {
      const out = serializeSnapshot(large, { maxChars });
      assert.ok(out.length <= maxChars, `${out.length} > ${maxChars}`);
      assert.match(out, /more elements omitted to fit the budget/);
      assert.match(out, /Cross-origin frames \(not entered\): 2/);
    });
  }

  it("puts elements in the viewport first and shortens long names", () => {
    const out = serializeSnapshot(large, { maxChars: 4000, maxNameChars: 50 });
    const firstElementLine = out.split("\n").find((line) => /^e\d+ /.test(line)) ?? "";
    assert.match(firstElementLine, /^e4900 button/);
    assert.ok(out.split("\n").every((line) => !line.includes("x".repeat(60))));
    assert.match(out, /\[text truncated, \d+ characters in total\]/);
  });

  it("renders a small page completely", () => {
    const small: Snapshot = {
      url: "https://test.example.org/",
      title: "Home",
      elements: [
        { ref: "e1", role: "link", name: "Home", url: "/", enabled: true, inViewport: true, inFrame: false },
        {
          ref: "e2",
          role: "combobox",
          name: "Topic",
          options: ["A", "B"],
          enabled: false,
          inViewport: true,
          inFrame: true,
        },
      ],
      text: "Welcome",
      crossOriginFrames: 0,
      dialogs: [],
      hash: "0".repeat(16),
    };
    assert.equal(
      serializeSnapshot(small),
      [
        "URL: https://test.example.org/",
        "Title: Home",
        "",
        "Elements (2 of 2):",
        'e1 link "Home" -> /',
        'e2 combobox "Topic" options=["A","B"] disabled (in frame)',
        "",
        "Text:",
        "Welcome",
      ].join("\n"),
    );
  });
});
