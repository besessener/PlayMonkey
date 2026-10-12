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

export const LLM_PROVIDERS = ["anthropic-foundry", "openai"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Default values; referenced by the schema (`default`) and by normalization so they cannot drift apart. */
export const DEFAULTS = {
  limits: { maxSteps: 500, maxMinutes: 20 },
  browser: { engine: "chromium" as Engine, viewport: [1280, 800] as [number, number], headless: true },
  stayOnDomain: true,
  oracle: true,
  report: { dir: "./monkey-report" },
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
  report?: { dir?: string };
}

export interface RawAuth {
  name: string;
  loginUrl?: string;
  fields?: Record<string, string>;
  submit?: string;
  storageState?: string;
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
