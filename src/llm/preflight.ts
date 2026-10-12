import type { LlmConfig } from "../config/config.ts";
import type { Secrets } from "../config/secrets.ts";
import type { LlmErrorKind, LlmProvider, PreflightResult } from "./provider.ts";

/** One line per failure class, telling what to check. */
export const PREFLIGHT_HINTS: Record<LlmErrorKind, string> = {
  unreachable: "endpoint not reachable: check llm.baseUrl, DNS, proxy and firewall",
  tls: "TLS handshake failed: check the certificate chain (corporate proxy? set NODE_EXTRA_CA_CERTS)",
  timeout: "no answer in time: check the network or raise llm.timeoutMs",
  auth: "authentication failed: check llm.apiKey (the key of this resource)",
  forbidden: "access denied: the key or identity lacks a role such as Foundry User on the resource",
  notFound:
    "deployment name not found: llm.deployment must be the Foundry deployment name, not the model ID; " +
    "llm.baseUrl must end in /anthropic",
  rateLimited: "rate limited: wait, lower the request rate, or raise the deployment's quota",
  badRequest: "request rejected: the deployment may not support a sent option (llm.options) or tool calling",
  server: "the endpoint had a server error: try again later",
  invalid: "tool calling unsupported or broken: the model answered without a well-formed tool call",
  refusal: "the model refused the probe request",
  maxTokens: "the response was cut off: raise llm.options.maxOutputTokens",
  other: "unexpected error",
};

/** Runs the provider's probe and returns the result with a ready-to-print message. Never throws. */
export async function runPreflight(
  provider: LlmProvider,
  llm: Pick<LlmConfig, "baseUrl" | "deployment">,
  secrets: Secrets,
): Promise<{ result: PreflightResult; message: string }> {
  const result = await provider.preflight();
  const where = `${provider.name} at ${sanitizeUrl(llm.baseUrl)}, deployment ${llm.deployment}`;
  if (result.ok) return { result, message: secrets.mask(`llm preflight ok: ${where} (${result.latencyMs} ms)`) };
  const { error } = result;
  const status = error.status === undefined ? "" : `, HTTP ${error.status}`;
  const message = [
    `llm preflight failed: ${where}${status}`,
    `  cause: ${error.kind}: ${error.message}`,
    `  hint: ${PREFLIGHT_HINTS[error.kind]}`,
  ].join("\n");
  return { result, message: secrets.mask(message) };
}

/** Origin and path only: no credentials, query or fragment. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}
