import type { JSONSchemaType } from "ajv";

export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = (typeof ENGINES)[number];

export const ORACLES = [
  "pageerror",
  "console",
  "http5xx",
  "http4xx",
  "crash",
  "hang",
  "errorPage",
  "overflow",
] as const;
export type OracleName = (typeof ORACLES)[number];

export const ACTION_TYPES = [
  "click",
  "fill",
  "select",
  "check",
  "press",
  "scroll",
  "back",
  "navigate",
  "setViewport",
  "switchTab",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const LLM_PROVIDERS = ["anthropic-foundry", "openai"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Default values; referenced by the schema (`default`) and by normalization so they cannot drift apart. */
export const DEFAULTS = {
  limits: { maxSteps: 500, maxMinutes: 20 },
  browser: { engine: "chromium" as Engine, viewport: [1280, 800] as [number, number], headless: true },
  stayOnDomain: true,
  oracle: true,
  report: { dir: "./monkey-report" },
  findings: { lastActions: 10, ignoreStatus: [] as number[] },
  monkey: {
    actionTimeoutMs: 5000,
    weights: {
      click: 10,
      fill: 6,
      select: 3,
      check: 3,
      press: 1,
      scroll: 1,
      back: 1.5,
      navigate: 1,
      setViewport: 0.2,
      switchTab: 1,
    } satisfies Record<ActionType, number>,
  },
} as const;

export const MAX_SEED = 2 ** 32 - 1;

/**
 * The config file as written by the user. Every optional key is `nullable` in the schema because Ajv's
 * `JSONSchemaType` requires it for optional properties; `null` itself is rejected before schema validation.
 */
export interface RawConfig {
  $schema?: string;
  baseUrl: string;
  seed?: number;
  limits?: { maxSteps?: number; maxMinutes?: number };
  browser?: { engine?: Engine; viewport?: [number, number]; headless?: boolean };
  stayOnDomain?: boolean;
  auth?: RawAuth[];
  testData?: Record<string, string>;
  llm?: RawLlm;
  oracles?: Partial<Record<OracleName, boolean>>;
  findings?: { lastActions?: number; ignoreStatus?: number[]; ignore?: RawIgnoreRule[] };
  report?: { dir?: string };
  monkey?: { actionTimeoutMs?: number; weights?: Partial<Record<ActionType, number>> };
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

export interface RawLlm {
  provider: LlmProvider;
  baseUrl: string;
  deployment: string;
  apiKey: string;
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
    llm: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["provider", "baseUrl", "deployment", "apiKey"],
      description: "Optional LLM used when the monkey is stuck. Absent means pure random monkey.",
      properties: {
        provider: { type: "string", enum: LLM_PROVIDERS },
        baseUrl: { ...nonEmptyString, description: "Endpoint base URL." },
        deployment: { ...nonEmptyString, description: "Deployment name used as model." },
        apiKey: { ...nonEmptyString, description: "API key; use a ${VAR} placeholder." },
      },
    },
    oracles: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "Switch individual oracles on or off. All are on by default.",
      properties: Object.fromEntries(
        ORACLES.map((name) => [name, { type: "boolean", nullable: true, default: DEFAULTS.oracle }]),
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
      },
    },
  },
};
