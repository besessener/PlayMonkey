import type { Config } from "../config/config.ts";
import { type Secrets, secretForms } from "../config/secrets.ts";
import { mapActionText } from "../monkey/actions.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import type { Decision } from "./provider.ts";

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/**
 * The `{{…}}` placeholders of the prompt. The model never sees a secret value: secrets in prompt text are replaced
 * by `{{env.NAME}}`, and the model refers to test data and the run's own login fields by `{{testData.<key>}}` and
 * `{{<role>.<field>}}`. `fill` puts the real values in after the model returned its action, but only for placeholders
 * the model was shown: the offered ones and the `{{env.NAME}}` that `hide` put into a prompt. The LLM's API key and
 * other roles' credentials are never filled in, whatever a page tells the model to type.
 */
export class PromptPlaceholders {
  readonly #values = new Map<string, string>();
  readonly #offered: string[] = [];
  /** Keys of `testData`, sorted. */
  readonly testDataKeys: string[];
  /** Secret value (in each of its forms) → placeholder, longest value first. */
  readonly #secrets: [string, string][];
  /** `env.NAME` → value, for the secrets the model may type once a prompt showed their placeholder. */
  readonly #typeable = new Map<string, string>();
  readonly #pattern: RegExp | undefined;

  constructor(config: Pick<Config, "testData" | "auth">, secrets: Secrets, role?: string) {
    this.testDataKeys = Object.keys(config.testData).sort();
    for (const key of this.testDataKeys) this.#add(`testData.${key}`, config.testData[key] as string);
    for (const auth of config.auth) {
      if (auth.kind !== "fields" || auth.name !== role) continue;
      for (const [field, value] of Object.entries(auth.fields)) this.#add(`${auth.name}.${field}`, value);
    }
    const typeable = new Set([...this.#values.values()]);
    this.#secrets = secrets.entries
      .flatMap(({ name, value }) => {
        // Only values the model may type anyway: never the API key or another role's credentials.
        if (typeable.has(value)) this.#typeable.set(`env.${name}`, value);
        return secretForms(value).map((form): [string, string] => [form, `{{env.${name}}}`]);
      })
      .sort(([a], [b]) => b.length - a.length);
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

  /** Replaces every secret value in `text`, also URL-encoded or JSON-escaped, with its `{{env.NAME}}` placeholder. */
  hide(text: string): string {
    if (this.#pattern === undefined) return text;
    const placeholders = new Map(this.#secrets);
    return text.replace(this.#pattern, (value) => {
      const placeholder = placeholders.get(value) ?? value;
      const name = placeholder.slice(2, -2);
      const typeable = this.#typeable.get(name);
      if (typeable !== undefined) this.#values.set(name, typeable);
      return placeholder;
    });
  }

  /** The snapshot with every secret hidden, before serializing cuts its text where a secret could be split. */
  hideSnapshot(snapshot: Snapshot): Snapshot {
    const hide = this.hide.bind(this);
    return {
      ...snapshot,
      url: hide(snapshot.url),
      title: hide(snapshot.title),
      text: hide(snapshot.text),
      dialogs: snapshot.dialogs.map(hide),
      elements: snapshot.elements.map((element) => ({
        ...element,
        name: hide(element.name),
        ...(element.url === undefined ? {} : { url: hide(element.url) }),
        ...(element.placeholder === undefined ? {} : { placeholder: hide(element.placeholder) }),
        ...(element.options === undefined ? {} : { options: element.options.map(hide) }),
      })),
    };
  }

  /** Replaces every placeholder the model was shown in `text` with its value; any other stays as typed. */
  fill(text: string): string {
    return text.replace(PLACEHOLDER, (match, name: string) => this.#values.get(name) ?? match);
  }

  /**
   * The decision with placeholders in typed values replaced. Never in a `navigate` URL: an address must not carry a
   * secret to the server or into the logs.
   */
  fillDecision(decision: Decision): Decision {
    switch (decision.type) {
      case "fill":
      case "select":
        return mapActionText(decision, (text) => this.fill(text)) as Decision;
      default:
        return decision;
    }
  }

  #add(name: string, value: string): void {
    this.#values.set(name, value);
    this.#offered.push(`{{${name}}}`);
  }
}
