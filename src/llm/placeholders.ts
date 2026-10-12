import type { Config } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";
import type { Decision } from "./provider.ts";

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/**
 * The `{{…}}` placeholders of the prompt. The model never sees a secret value: secrets in prompt text are replaced
 * by `{{env.NAME}}`, and the model refers to test data and login fields by `{{testData.<key>}}` and
 * `{{<role>.<field>}}`. `fill` puts the real values in after the model returned its action.
 */
export class PromptPlaceholders {
  readonly #values = new Map<string, string>();
  readonly #offered: string[] = [];
  /** Keys of `testData`, sorted. */
  readonly testDataKeys: string[];
  /** Secret value → placeholder, longest value first. */
  readonly #secrets: [string, string][];
  readonly #pattern: RegExp | undefined;

  constructor(config: Pick<Config, "testData" | "auth">, secrets: Secrets) {
    this.testDataKeys = Object.keys(config.testData).sort();
    for (const key of this.testDataKeys) this.#add(`testData.${key}`, config.testData[key] as string);
    for (const role of config.auth) {
      if (role.kind !== "fields") continue;
      for (const [field, value] of Object.entries(role.fields)) this.#add(`${role.name}.${field}`, value);
    }
    this.#secrets = secrets.entries
      .map(({ name, value }): [string, string] => [value, `{{env.${name}}}`])
      .sort(([a], [b]) => b.length - a.length);
    for (const [value, placeholder] of this.#secrets) this.#values.set(placeholder.slice(2, -2), value);
    if (this.#secrets.length > 0) {
      this.#pattern = new RegExp(
        this.#secrets.map(([value]) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "g",
      );
    }
  }

  /** Placeholders to list in the prompt, e.g. `{{testData.email}}`, `{{admin.password}}`. */
  get offered(): string[] {
    return [...this.#offered];
  }

  /** Replaces every secret value in `text` with its `{{env.NAME}}` placeholder. */
  hide(text: string): string {
    if (this.#pattern === undefined) return text;
    const placeholders = new Map(this.#secrets);
    return text.replace(this.#pattern, (value) => placeholders.get(value) ?? value);
  }

  /** Replaces every known placeholder in `text` with its value; unknown ones stay as typed. */
  fill(text: string): string {
    return text.replace(PLACEHOLDER, (match, name: string) => this.#values.get(name) ?? match);
  }

  /** The decision with placeholders in its free-text fields replaced. */
  fillDecision(decision: Decision): Decision {
    switch (decision.type) {
      case "fill":
      case "select":
        return { ...decision, value: this.fill(decision.value) };
      case "navigate":
        return { ...decision, url: this.fill(decision.url) };
      default:
        return decision;
    }
  }

  #add(name: string, value: string): void {
    this.#values.set(name, value);
    this.#offered.push(`{{${name}}}`);
  }
}
