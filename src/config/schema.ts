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
  llm: {
    required: true,
    timeoutMs: 60_000,
    maxRetries: 2,
    debugLog: false,
    historyActions: 10,
    snapshotChars: 8000,
    handoff: {
      noStateChange: 5,
      noProgress: 25,
      failedActions: 5,
      invalidForm: 3,
      blockingUi: true,
      loginWall: true,
      maxDecisions: 3,
      cooldownSteps: 5,
    },
    breaker: { failures: 3, pauseSteps: 20 },
    options: { maxOutputTokens: 4096 },
  },
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

export const THINKING_TYPES = ["adaptive", "disabled", "between_tools"] as const;
export type ThinkingType = (typeof THINKING_TYPES)[number];
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
/** API surface of the `openai` backend: the Responses API or Chat Completions. */
export const OPENAI_APIS = ["responses", "chat"] as const;
export type OpenAiApi = (typeof OPENAI_APIS)[number];

export interface RawLlm {
  provider: LlmProvider;
  baseUrl: string;
  deployment: string;
  apiKey: string;
  required?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  maxCalls?: number;
  maxTokens?: number;
  debugLog?: boolean;
  historyActions?: number;
  snapshotChars?: number;
  handoff?: Partial<RawHandoff>;
  breaker?: { failures?: number; pauseSteps?: number };
  pricing?: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };
  options?: { maxOutputTokens?: number; thinking?: ThinkingType; effort?: EffortLevel; api?: OpenAiApi };
}

export interface RawHandoff {
  noStateChange: number;
  noProgress: number;
  failedActions: number;
  invalidForm: number;
  blockingUi: boolean;
  loginWall: boolean;
  maxDecisions: number;
  cooldownSteps: number;
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
        required: {
          type: "boolean",
          nullable: true,
          default: DEFAULTS.llm.required,
          description: "Exit with code 2 when the preflight check fails; false continues as pure random monkey.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          nullable: true,
          default: DEFAULTS.llm.timeoutMs,
          description: "Timeout of one LLM request in milliseconds.",
        },
        maxRetries: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          nullable: true,
          default: DEFAULTS.llm.maxRetries,
          description: "Retries of a request after a rate limit, server or connection error.",
        },
        maxCalls: {
          type: "integer",
          minimum: 0,
          nullable: true,
          description: "Budget: LLM calls per run (all roles). Unlimited when absent.",
        },
        maxTokens: {
          type: "integer",
          minimum: 0,
          nullable: true,
          description: "Budget: tokens per run (all roles; input, output and cache). Unlimited when absent.",
        },
        debugLog: {
          type: "boolean",
          nullable: true,
          default: DEFAULTS.llm.debugLog,
          description: "Write sanitized prompts and responses to llm-debug.jsonl in the report directory.",
        },
        historyActions: {
          type: "integer",
          minimum: 0,
          nullable: true,
          default: DEFAULTS.llm.historyActions,
          description: "Number of recent actions shown to the LLM.",
        },
        snapshotChars: {
          type: "integer",
          minimum: 500,
          nullable: true,
          default: DEFAULTS.llm.snapshotChars,
          description: "Character budget of the page snapshot in the prompt.",
        },
        handoff: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          required: [],
          description: "When the monkey hands the next decisions to the LLM.",
          properties: {
            noStateChange: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.handoff.noStateChange,
              description: "Steps in a row without any change of the page.",
            },
            noProgress: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.handoff.noProgress,
              description: "Steps in a row without discovering a new state.",
            },
            failedActions: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.handoff.failedActions,
              description: "Failed monkey actions in a row.",
            },
            invalidForm: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.handoff.invalidForm,
              description: "Form submissions in a row that end on validation errors.",
            },
            blockingUi: {
              type: "boolean",
              nullable: true,
              default: DEFAULTS.llm.handoff.blockingUi,
              description: "Hand off when a dialog, overlay or cookie banner is open.",
            },
            loginWall: {
              type: "boolean",
              nullable: true,
              default: DEFAULTS.llm.handoff.loginWall,
              description: "Hand off when a role that logged in lands on a login page.",
            },
            maxDecisions: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.handoff.maxDecisions,
              description: "Consecutive LLM decisions per handoff.",
            },
            cooldownSteps: {
              type: "integer",
              minimum: 0,
              nullable: true,
              default: DEFAULTS.llm.handoff.cooldownSteps,
              description: "Monkey steps after a handoff before the next one.",
            },
          },
        },
        breaker: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          required: [],
          description: "Circuit breaker for an unavailable LLM.",
          properties: {
            failures: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.breaker.failures,
              description: "Failed LLM decisions in a row that open the breaker.",
            },
            pauseSteps: {
              type: "integer",
              minimum: 1,
              nullable: true,
              default: DEFAULTS.llm.breaker.pauseSteps,
              description: "Steps without LLM while the breaker is open.",
            },
          },
        },
        pricing: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          required: ["inputPerMTok", "outputPerMTok"],
          description: "Prices per million tokens, for an estimated cost in the report. No built-in prices.",
          properties: {
            inputPerMTok: { type: "number", minimum: 0, description: "Price per million input tokens." },
            outputPerMTok: { type: "number", minimum: 0, description: "Price per million output tokens." },
            cacheReadPerMTok: {
              type: "number",
              minimum: 0,
              nullable: true,
              description: "Price per million cache-read tokens; inputPerMTok when absent.",
            },
            cacheWritePerMTok: {
              type: "number",
              minimum: 0,
              nullable: true,
              description: "Price per million cache-write tokens; inputPerMTok when absent.",
            },
          },
        },
        options: {
          type: "object",
          nullable: true,
          additionalProperties: false,
          required: [],
          description: "Model request options.",
          properties: {
            maxOutputTokens: {
              type: "integer",
              minimum: 16,
              nullable: true,
              default: DEFAULTS.llm.options.maxOutputTokens,
              description: "Output token limit of a request, including thinking or reasoning tokens.",
            },
            thinking: {
              type: "string",
              enum: THINKING_TYPES,
              nullable: true,
              description: "anthropic-foundry only: thinking mode sent to the model; the model's default when absent.",
            },
            effort: {
              type: "string",
              enum: EFFORT_LEVELS,
              nullable: true,
              description:
                "Effort level sent to the model (Anthropic effort, OpenAI reasoning effort); the model's default when absent.",
            },
            api: {
              type: "string",
              enum: OPENAI_APIS,
              nullable: true,
              description: "openai only: the Responses API (default) or Chat Completions.",
            },
          },
        },
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
