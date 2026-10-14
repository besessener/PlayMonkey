import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoverageTracker, type RunCoverage } from "../src/monkey/coverage.ts";
import type { StepRecord } from "../src/monkey/loop.ts";
import { UrlScope } from "../src/monkey/scope.ts";
import { aggregateCoverage, coverageSection } from "../src/report/coverage.ts";
import type { RoleOutcome } from "../src/run.ts";
import type { Snapshot, SnapshotElement } from "../src/snapshot/snapshot.ts";

const ORIGIN = "https://test.example.org";

const link = (url: string): SnapshotElement => ({
  ref: "e1",
  role: "link",
  name: url,
  url,
  enabled: true,
  inViewport: true,
  inFrame: false,
});

function step(url: string, hash: string, links: string[] = []): [StepRecord, Snapshot] {
  const record: StepRecord = {
    step: 1,
    action: { type: "scroll", deltaY: 300 },
    url,
    snapshotHash: hash,
    source: "monkey",
    result: { ok: true, navigated: false, url, tab: 0 },
  };
  const snapshot: Snapshot = {
    url,
    title: "t",
    elements: links.map(link),
    text: "",
    crossOriginFrames: 0,
    dialogs: [],
    hash,
  };
  return [record, snapshot];
}

describe("CoverageTracker", () => {
  it("counts steps and states per page, with ids and queries normalized like dedup keys", () => {
    const tracker = new CoverageTracker({
      origin: ORIGIN,
      stayOnDomain: true,
      scope: new UrlScope({ allow: [], deny: [] }),
    });
    tracker.record(...step(`${ORIGIN}/`, "a"));
    tracker.record(...step(`${ORIGIN}/`, "b"));
    tracker.record(...step(`${ORIGIN}/`, "a"));
    tracker.record(...step(`${ORIGIN}/orders/17?tab=2`, "c"));
    tracker.record(...step(`${ORIGIN}/orders/18`, "d"));
    assert.deepEqual(tracker.summary().pages, [
      { page: "/", steps: 3, states: 2 },
      { page: "/orders/:n", steps: 2, states: 2 },
    ]);
  });

  it("lists linked pages the run may open but never acted on", () => {
    const scope = new UrlScope({ allow: [], deny: ["/logout"] });
    const tracker = new CoverageTracker({ origin: ORIGIN, stayOnDomain: true, scope });
    tracker.record(
      ...step(`${ORIGIN}/`, "a", [
        "/cart",
        "/checkout?step=1",
        "/logout",
        "https://elsewhere.example/",
        "mailto:x@example.org",
        "/",
        "http://[bad",
      ]),
    );
    tracker.record(...step(`${ORIGIN}/cart`, "b", ["/checkout"]));
    assert.deepEqual(tracker.summary().unvisited, ["/checkout"]);

    const anywhere = new CoverageTracker({
      origin: ORIGIN,
      stayOnDomain: false,
      scope: new UrlScope({ allow: [], deny: [] }),
    });
    anywhere.record(...step(`${ORIGIN}/`, "a", ["https://elsewhere.example/a"]));
    assert.deepEqual(anywhere.summary().unvisited, ["https://elsewhere.example/a"]);
  });
});

describe("coverage in the report", () => {
  const run = (coverage?: RunCoverage): RoleOutcome => ({
    role: "user",
    seed: 1,
    findings: [],
    blockedNavigations: 0,
    ...(coverage === undefined ? {} : { coverage }),
  });

  it("merges runs: steps add up, and a page one run reached is not unvisited", () => {
    const merged = aggregateCoverage([
      run({ pages: [{ page: "/", steps: 4, states: 2 }], unvisited: ["/cart", "/help"] }),
      run(),
      run({
        pages: [
          { page: "/", steps: 1, states: 1 },
          { page: "/cart", steps: 3, states: 1 },
        ],
        unvisited: ["/checkout"],
      }),
    ]);
    assert.deepEqual(merged, {
      pages: [
        { page: "/", steps: 5, runs: 2 },
        { page: "/cart", steps: 3, runs: 1 },
      ],
      unvisited: ["/checkout", "/help"],
    });
  });

  it("renders the section escaped, and says when nothing was left unvisited", () => {
    const evil = "/<script>alert(1)</script>";
    const html = coverageSection({ pages: [{ page: evil, steps: 1, runs: 1 }], unvisited: [evil] });
    assert.ok(!html.includes("<script>"));
    assert.match(html, /1 page visited/);
    assert.match(html, /Linked but never visited/);
    assert.match(coverageSection({ pages: [], unvisited: [] }), /0 pages visited[\s\S]*Every linked page/);
  });
});
