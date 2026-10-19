import type { JSONSchemaType } from "ajv";
import { DEFAULTS } from "./defaults.ts";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  LLM_MODES,
  LLM_PROVIDERS,
  type LlmMode,
  type LlmProvider,
  OPENAI_APIS,
  type OpenAiApi,
  THINKING_TYPES,
  type ThinkingType,
} from "./values.ts";

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
  vision?: boolean;
  mode?: LlmMode;
  goal?: string;
  agent?: { maxDecisions?: number; monkeySteps?: number };
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

/** The `llm` section of `configSchema`, which checks it again as an optional key. */
export const llmSchema: JSONSchemaType<RawLlm> & { nullable: true } = {
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
      description: "Time limit of one LLM request in milliseconds, including retries and reading the response.",
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
    vision: {
      type: "boolean",
      nullable: true,
      default: DEFAULTS.llm.vision,
      description: "Attach a screenshot of the viewport, with secrets blacked out, to every action decision.",
    },
    mode: {
      type: "string",
      enum: LLM_MODES,
      nullable: true,
      default: DEFAULTS.llm.mode,
      description: "handoff: the LLM decides only when the monkey is stuck; agent: it drives in turns.",
    },
    goal: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      nullable: true,
      description: "What the LLM should pursue during the run, e.g. a user flow; shown in every prompt.",
    },
    agent: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      description: "Turns in llm.mode agent.",
      properties: {
        maxDecisions: {
          type: "integer",
          minimum: 1,
          nullable: true,
          default: DEFAULTS.llm.agent.maxDecisions,
          description: "Consecutive LLM decisions per turn.",
        },
        monkeySteps: {
          type: "integer",
          minimum: 0,
          nullable: true,
          default: DEFAULTS.llm.agent.monkeySteps,
          description: "Random monkey steps between two turns.",
        },
      },
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
};
