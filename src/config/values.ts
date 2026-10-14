/** Allowed values of config keys, shared by the schema, the defaults and the code that reads the config. */

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
  "download",
  "accessibility",
] as const;
export type OracleName = (typeof ORACLES)[number];

export const ACTION_TYPES = [
  "click",
  "dblclick",
  "rightclick",
  "hover",
  "longPress",
  "drag",
  "fill",
  "select",
  "check",
  "press",
  "scroll",
  "back",
  "navigate",
  "setViewport",
  "switchTab",
  "offline",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const LLM_PROVIDERS = ["anthropic-foundry", "openai"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const THINKING_TYPES = ["adaptive", "disabled", "between_tools"] as const;
export type ThinkingType = (typeof THINKING_TYPES)[number];
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
/** API surface of the `openai` backend: the Responses API or Chat Completions. */
export const OPENAI_APIS = ["responses", "chat"] as const;
export type OpenAiApi = (typeof OPENAI_APIS)[number];

export const MAX_SEED = 2 ** 32 - 1;
