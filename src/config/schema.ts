import type { JSONSchemaType } from "ajv";
import { DEFAULTS } from "./defaults.ts";
import { llmSchema, type RawLlm } from "./llm-schema.ts";
import { ACTION_TYPES, type ActionType, ENGINES, type Engine, MAX_SEED, ORACLES, type OracleName } from "./values.ts";

/**
 * The config file as written by the user. Every optional key is `nullable` in the schema because Ajv's
 * `JSONSchemaType` requires it for optional properties; `null` itself is rejected before schema validation.
 */
export interface RawConfig {
  $schema?: string;
  baseUrl: string;
  seed?: number;
  seeds?: number[];
  parallel?: number;
  limits?: { maxSteps?: number; maxMinutes?: number };
  browser?: { engine?: Engine; viewport?: [number, number]; headless?: boolean };
  stayOnDomain?: boolean;
  scope?: { allow?: string[]; deny?: string[] };
  network?: { latencyMs?: number };
  auth?: RawAuth[];
  testData?: Record<string, string>;
  llm?: RawLlm;
  oracles?: Partial<Record<OracleName, boolean>>;
  findings?: { lastActions?: number; ignoreStatus?: number[]; ignore?: RawIgnoreRule[]; baseline?: string };
  report?: { dir?: string; keepDownloads?: boolean };
  monkey?: { actionTimeoutMs?: number; maxTabs?: number; weights?: Partial<Record<ActionType, number>> };
}

export interface RawAuth {
  name: string;
  loginUrl?: string;
  fields?: Record<string, string>;
  submit?: string;
  storageState?: string;
}

/** Drops matching signals before they become findings. Patterns are JavaScript regular expressions. */
export interface RawIgnoreRule {
  oracle?: OracleName;
  url?: string;
  message?: string;
}

const nonEmptyString = { type: "string", minLength: 1 } as const;

const stringMap = {
  type: "object",
  required: [],
  additionalProperties: { type: "string" },
} as const;

export const configSchema: JSONSchemaType<RawConfig> = {
  type: "object",
  additionalProperties: false,
  required: ["baseUrl"],
  properties: {
    $schema: { type: "string", nullable: true, description: "Optional JSON Schema reference for editors." },
    baseUrl: { ...nonEmptyString, description: "Absolute http(s) URL of the site under test." },
    seed: {
      type: "integer",
      minimum: 0,
      maximum: MAX_SEED,
      nullable: true,
      description: "Seed for the random monkey. A random seed is generated and printed when absent.",
    },
    seeds: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: MAX_SEED },
      minItems: 1,
      uniqueItems: true,
      nullable: true,
      description:
        "One run per seed and role, instead of seed. Each run writes to <role>/<seed>/ in the report directory.",
    },
    parallel: {
      type: "integer",
      minimum: 1,
      maximum: 64,
      nullable: true,
      default: DEFAULTS.parallel,
      description: "Runs (roles × seeds) at the same time, each in its own browser context.",
    },
    limits: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      properties: {
        maxSteps: {
          type: "integer",
          minimum: 1,
          nullable: true,
          default: DEFAULTS.limits.maxSteps,
          description: "Maximum number of actions per role.",
        },
        maxMinutes: {
          type: "number",
          exclusiveMinimum: 0,
          nullable: true,
          default: DEFAULTS.limits.maxMinutes,
          description: "Maximum wall-clock minutes per role.",
        },
      },
    },
    browser: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      properties: {
        engine: {
          type: "string",
          enum: ENGINES,
          nullable: true,
          default: DEFAULTS.browser.engine,
          description: "Playwright browser engine.",
        },
        viewport: {
          type: "array",
          items: [
            { type: "integer", minimum: 1 },
            { type: "integer", minimum: 1 },
          ],
          minItems: 2,
          maxItems: 2,
          nullable: true,
          default: DEFAULTS.browser.viewport,
          description: "Viewport as [width, height] in CSS pixels.",
        },
        headless: {
          type: "boolean",
          nullable: true,
          default: DEFAULTS.browser.headless,
          description: "Run the browser without a window.",
        },
      },
    },
    stayOnDomain: {
      type: "boolean",
      nullable: true,
      default: DEFAULTS.stayOnDomain,
      description: "Keep the monkey on the origin of baseUrl.",
    },
    scope: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "Which pages the monkey may open: regular expressions matched against the full URL.",
      properties: {
        allow: {
          type: "array",
          items: nonEmptyString,
          nullable: true,
          default: DEFAULTS.scope.allow,
          description: "When not empty, only URLs matching one of these patterns are opened.",
        },
        deny: {
          type: "array",
          items: nonEmptyString,
          nullable: true,
          default: DEFAULTS.scope.deny,
          description: "URLs matching one of these patterns are never opened.",
        },
      },
    },
    network: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "Network conditions of the run. Going offline is the monkey action offline (monkey.weights).",
      properties: {
        latencyMs: {
          type: "integer",
          minimum: 0,
          maximum: 60_000,
          nullable: true,
          default: DEFAULTS.network.latencyMs,
          description: "Delay added to every request of the run in milliseconds; 0 for none.",
        },
      },
    },
    auth: {
      type: "array",
      nullable: true,
      description: "Roles to run as. Each uses either fields (with loginUrl and submit) or storageState.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { ...nonEmptyString, description: "Unique role name." },
          loginUrl: { ...nonEmptyString, nullable: true, description: "Login page path, relative to baseUrl." },
          fields: { ...stringMap, nullable: true, minProperties: 1, description: "Login form fields to fill." },
          submit: { ...nonEmptyString, nullable: true, description: "Selector of the login submit button." },
          storageState: {
            ...nonEmptyString,
            nullable: true,
            description: "Path to a Playwright storageState file, relative to the config file.",
          },
        },
      },
    },
    testData: { ...stringMap, nullable: true, description: "Valid values the monkey may use when filling fields." },
    llm: llmSchema,
    oracles: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "Switch individual oracles on or off. All but accessibility are on by default.",
      properties: Object.fromEntries(
        ORACLES.map((name) => [name, { type: "boolean", nullable: true, default: DEFAULTS.oracles[name] }]),
      ) as JSONSchemaType<RawConfig>["properties"]["oracles"]["properties"],
    },
    findings: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "What becomes a finding and how much context it keeps.",
      properties: {
        lastActions: {
          type: "integer",
          minimum: 0,
          nullable: true,
          default: DEFAULTS.findings.lastActions,
          description: "Number of actions before a finding that it records, for reproduction.",
        },
        ignoreStatus: {
          type: "array",
          items: { type: "integer", minimum: 400, maximum: 599 },
          uniqueItems: true,
          nullable: true,
          default: DEFAULTS.findings.ignoreStatus,
          description: "HTTP statuses that are never findings, e.g. [401, 403].",
        },
        ignore: {
          type: "array",
          nullable: true,
          description: "Rules that drop known noise. A signal matching every given part of a rule is ignored.",
          items: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              oracle: { type: "string", enum: ORACLES, nullable: true, description: "Only signals of this oracle." },
              url: {
                ...nonEmptyString,
                nullable: true,
                description: "Regular expression matched against the URL (the request URL for HTTP findings).",
              },
              message: {
                ...nonEmptyString,
                nullable: true,
                description: "Regular expression matched against the finding message.",
              },
            },
          },
        },
        baseline: {
          ...nonEmptyString,
          nullable: true,
          description:
            "baseline.json of an earlier run, relative to the config file. Its findings are known and do not fail the run.",
        },
      },
    },
    monkey: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "Tuning of the random monkey.",
      properties: {
        actionTimeoutMs: {
          type: "integer",
          minimum: 100,
          nullable: true,
          default: DEFAULTS.monkey.actionTimeoutMs,
          description: "Timeout of a single action in milliseconds; a slower action fails and the run continues.",
        },
        maxTabs: {
          type: "integer",
          minimum: 1,
          nullable: true,
          default: DEFAULTS.monkey.maxTabs,
          description: "Open tabs per role; when popups open more, the oldest ones the monkey left are closed.",
        },
        weights: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          required: [],
          description: "Relative weight of each action type; 0 disables it.",
          properties: Object.fromEntries(
            ACTION_TYPES.map((type) => [
              type,
              { type: "number", minimum: 0, nullable: true, default: DEFAULTS.monkey.weights[type] },
            ]),
          ) as JSONSchemaType<RawConfig>["properties"]["monkey"]["properties"]["weights"]["properties"],
        },
      },
    },
    report: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      properties: {
        dir: {
          ...nonEmptyString,
          nullable: true,
          default: DEFAULTS.report.dir,
          description: "Report output directory, relative to the config file.",
        },
        keepDownloads: {
          type: "boolean",
          nullable: true,
          default: DEFAULTS.report.keepDownloads,
          description: "Keep the files the site under test downloaded, in <role>/downloads of the report directory.",
        },
      },
    },
  },
};
