import type { ActionType } from "../config/values.ts";
import { unblockingElements } from "../snapshot/blocking.ts";
import type { Snapshot, SnapshotElement } from "../snapshot/snapshot.ts";
import type { Action } from "./actions.ts";
import type { Random } from "./random.ts";
import { chooseFillValue } from "./values.ts";

const FILL_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
const CHECK_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const SELECT_ROLES = new Set(["combobox", "listbox"]);

const KEYS = ["Tab", "Shift+Tab", "Enter", "Escape", "ArrowDown", "ArrowUp", "Space"];
const SCROLL_STEPS = [-800, -300, 300, 800];
const VIEWPORTS: readonly [number, number][] = [
  [375, 667],
  [768, 1024],
  [1280, 800],
  [1920, 1080],
];

/** Bonus factor for links to a URL the run has not visited yet. */
const UNVISITED_LINK_BONUS = 3;
/** Bonus factor for elements that answer an open dialog or consent banner, which usually covers everything else. */
const UNBLOCKING_BONUS = 10;
/** Action types that act on any clickable element, besides `click` itself. */
const POINTER_TYPES = ["dblclick", "rightclick", "hover", "drag"] as const;
/** Viewports narrower than this are phones and tablets, where a long press is a common gesture. */
const TOUCH_WIDTH = 1024;

/** What the chooser remembers across steps. Owned by the run loop. */
export class Exploration {
  /** `url + hash` of every state seen. */
  readonly states = new Set<string>();
  /** Same-origin URLs seen, in order of discovery: targets for `navigate`. */
  readonly urls: string[] = [];
  readonly #acted = new Map<string, number>();

  /** Records a state; returns true when it is new. */
  visit(url: string, hash: string): boolean {
    if (!this.urls.includes(url)) this.urls.push(url);
    const key = `${url}#${hash}`;
    if (this.states.has(key)) return false;
    this.states.add(key);
    return true;
  }

  actedOn(stateKey: string, elementKey: string): number {
    return this.#acted.get(`${stateKey}\u0000${elementKey}`) ?? 0;
  }

  recordAction(stateKey: string, elementKey: string): void {
    const key = `${stateKey}\u0000${elementKey}`;
    this.#acted.set(key, (this.#acted.get(key) ?? 0) + 1);
  }
}

export interface ChooseOptions {
  weights: Record<ActionType, number>;
  testData: Record<string, string>;
  /** Origin the monkey must stay on, or undefined when `stayOnDomain` is off. */
  origin?: string;
  tabCount: number;
  currentTab: number;
  viewport: { width: number; height: number };
}

interface Candidate {
  type: ActionType;
  element?: SnapshotElement;
}

/**
 * Picks the next action: first an action type by its weight (among the types possible on this page), then an
 * element of that type, preferring elements not yet used in this state and links to unvisited pages.
 */
export function chooseAction(
  snapshot: Snapshot,
  exploration: Exploration,
  random: Random,
  options: ChooseOptions,
): { action: Action; elementKey?: string } {
  const byType = candidatesByType(snapshot, exploration, options);
  const types = [...byType.keys()].filter((candidateType) => options.weights[candidateType] > 0);
  if (types.length === 0) return { action: { type: "scroll", deltaY: random.pick(SCROLL_STEPS) } };
  const type = random.weighted(types, (t) => options.weights[t]);
  const candidates = byType.get(type) ?? [];

  const withElement = candidates.filter((candidate) => candidate.element !== undefined);
  if (withElement.length > 0) return chooseElementAction(type, withElement, { snapshot, exploration, random, options });
  return { action: globalAction(type, exploration, random, options) };
}

/** The action types possible on this page, each with its candidates (elements, or none for global actions). */
function candidatesByType(
  snapshot: Snapshot,
  exploration: Exploration,
  options: ChooseOptions,
): Map<ActionType, Candidate[]> {
  const byType = new Map<ActionType, Candidate[]>();
  const add = (candidate: Candidate) => byType.set(candidate.type, [...(byType.get(candidate.type) ?? []), candidate]);

  for (const element of snapshot.elements) {
    for (const candidate of elementCandidates(element, snapshot.url, options)) add(candidate);
  }
  for (const type of ["press", "scroll", "back", "setViewport"] as const) add({ type });
  if (exploration.urls.length > 0) add({ type: "navigate" });
  if (options.tabCount > 1) add({ type: "switchTab" });
  return byType;
}

/** The candidates for one element, in the order they are offered. */
function elementCandidates(element: SnapshotElement, pageUrl: string, options: ChooseOptions): Candidate[] {
  if (!element.enabled) return [];
  if (CHECK_ROLES.has(element.role)) return [{ type: "check", element }];
  if (FILL_ROLES.has(element.role)) return [{ type: "fill", element }];
  if (SELECT_ROLES.has(element.role)) return (element.options?.length ?? 0) > 0 ? [{ type: "select", element }] : [];
  // Buttons, links and anything the page marks clickable.
  if (element.role === "link" && !staysOnOrigin(element, pageUrl, options.origin)) return [];
  const candidates: Candidate[] = [{ type: "click", element }];
  for (const type of POINTER_TYPES) candidates.push({ type, element });
  if (options.viewport.width < TOUCH_WIDTH) candidates.push({ type: "longPress", element });
  return candidates;
}

interface ChooseContext {
  snapshot: Snapshot;
  exploration: Exploration;
  random: Random;
  options: ChooseOptions;
}

/** Picks an element among the candidates of `type`, weighted by `elementWeight`, and the action on it. */
function chooseElementAction(
  type: ActionType,
  withElement: Candidate[],
  { snapshot, exploration, random, options }: ChooseContext,
): { action: Action; elementKey: string } {
  const keys = elementKeys(snapshot.elements);
  const weighing: WeightContext = {
    keys,
    stateKey: `${snapshot.url}#${snapshot.hash}`,
    exploration,
    pageUrl: snapshot.url,
  };
  const unblocking = unblockingElements(snapshot);
  const chosen = random.weighted(withElement, (candidate) => {
    const element = candidate.element as SnapshotElement;
    const weight = elementWeight(element, weighing);
    return unblocking.has(element) ? weight * UNBLOCKING_BONUS : weight;
  });
  const element = chosen.element as SnapshotElement;
  if (type === "drag") {
    // Best effort: drop onto another element; real drop zones are often not actionable themselves.
    const others = snapshot.elements.filter((other) => other !== element && other.enabled);
    if (others.length === 0)
      return { action: { type: "hover", ref: element.ref }, elementKey: keys.get(element) as string };
    const to = random.pick(others);
    return { action: { type: "drag", ref: element.ref, toRef: to.ref }, elementKey: keys.get(element) as string };
  }
  return { action: elementAction(type, element, random, options), elementKey: keys.get(element) as string };
}

interface WeightContext {
  keys: Map<SnapshotElement, string>;
  stateKey: string;
  exploration: Exploration;
  pageUrl: string;
}

function elementWeight(element: SnapshotElement, { keys, stateKey, exploration, pageUrl }: WeightContext): number {
  let weight = 1 / (1 + exploration.actedOn(stateKey, keys.get(element) as string));
  if (element.role === "link" && element.url !== undefined) {
    const target = new URL(element.url, pageUrl).href;
    if (!exploration.urls.includes(target)) weight *= UNVISITED_LINK_BONUS;
  }
  return weight;
}

function elementAction(type: ActionType, element: SnapshotElement, random: Random, options: ChooseOptions): Action {
  switch (type) {
    case "fill":
      return { type: "fill", ref: element.ref, value: chooseFillValue(element, options.testData, random) };
    case "select":
      return { type: "select", ref: element.ref, value: random.pick(element.options ?? []) };
    case "check":
      return element.checked === true ? { type: "uncheck", ref: element.ref } : { type: "check", ref: element.ref };
    case "dblclick":
    case "rightclick":
    case "hover":
    case "longPress":
      return { type, ref: element.ref };
    default:
      return { type: "click", ref: element.ref };
  }
}

function globalAction(type: ActionType, exploration: Exploration, random: Random, options: ChooseOptions): Action {
  switch (type) {
    case "press":
      return { type: "press", key: random.pick(KEYS) };
    case "back":
      return { type: "back" };
    case "navigate":
      return { type: "navigate", url: random.pick(exploration.urls) };
    case "setViewport": {
      const sizes = VIEWPORTS.filter(([w, h]) => w !== options.viewport.width || h !== options.viewport.height);
      const [width, height] = random.pick(sizes);
      return { type: "setViewport", width, height };
    }
    case "switchTab": {
      const others = Array.from({ length: options.tabCount }, (_, i) => i).filter((i) => i !== options.currentTab);
      return { type: "switchTab", index: random.pick(others) };
    }
    default:
      return { type: "scroll", deltaY: random.pick(SCROLL_STEPS) };
  }
}

/** Identity of an element within a state that survives re-snapshots: role, name and occurrence index. */
function elementKeys(elements: SnapshotElement[]): Map<SnapshotElement, string> {
  const seen = new Map<string, number>();
  const keys = new Map<SnapshotElement, string>();
  for (const element of elements) {
    const base = `${element.role}\u0000${element.name}`;
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    keys.set(element, `${base}\u0000${index}`);
  }
  return keys;
}

function staysOnOrigin(element: SnapshotElement, pageUrl: string, origin: string | undefined): boolean {
  if (origin === undefined || element.url === undefined) return true;
  try {
    const target = new URL(element.url, pageUrl);
    return target.protocol === "javascript:" || target.origin === origin;
  } catch {
    return true;
  }
}
