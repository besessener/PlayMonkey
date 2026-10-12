import { LlmError, type LlmErrorKind } from "./provider.ts";

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The typed errors of a Stainless-generated SDK. The Anthropic and the OpenAI SDK both export these classes under the
 * same names, as statics of their client class.
 */
export interface SdkErrorClasses {
  APIError: ErrorClass;
  APIConnectionError: ErrorClass;
  APIConnectionTimeoutError: ErrorClass;
  AuthenticationError: ErrorClass;
  PermissionDeniedError: ErrorClass;
  NotFoundError: ErrorClass;
  RateLimitError: ErrorClass;
  BadRequestError: ErrorClass;
  UnprocessableEntityError: ErrorClass;
  InternalServerError: ErrorClass;
}

/** Network error codes (walked through `cause`) that mean the TLS handshake or certificate failed. */
const TLS_CODES = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/;

/**
 * Maps an SDK error to an `LlmError`, most specific class first. The message is the first line only and never
 * contains the API key.
 */
export function mapSdkError(
  C: SdkErrorClasses,
  error: unknown,
  context: { apiKey: string; timeoutMs: number; retries: number },
): LlmError {
  const { retries } = context;
  const scrub = (text: string) => text.replaceAll(context.apiKey, "***").split("\n")[0] ?? "";
  const http = (kind: LlmErrorKind, e: Error) => {
    const status = (e as { status?: unknown }).status;
    return new LlmError(kind, scrub(e.message), { ...(typeof status === "number" ? { status } : {}), retries });
  };
  if (error instanceof C.APIConnectionTimeoutError) {
    return new LlmError("timeout", `no response within ${context.timeoutMs} ms`, { retries });
  }
  if (error instanceof C.APIConnectionError) {
    const code = causeCode(error);
    const kind = code !== undefined && TLS_CODES.test(code) ? "tls" : "unreachable";
    return new LlmError(kind, `connection failed${code === undefined ? "" : ` (${code})`}`, { retries });
  }
  if (error instanceof C.AuthenticationError) return http("auth", error);
  if (error instanceof C.PermissionDeniedError) return http("forbidden", error);
  if (error instanceof C.NotFoundError) return http("notFound", error);
  if (error instanceof C.RateLimitError) return http("rateLimited", error);
  if (error instanceof C.BadRequestError || error instanceof C.UnprocessableEntityError) {
    return http("badRequest", error);
  }
  if (error instanceof C.InternalServerError) return http("server", error);
  if (error instanceof C.APIError) return http("other", error);
  return new LlmError("other", scrub(error instanceof Error ? error.message : String(error)), { retries });
}

/** The first `code` in an error's cause chain, e.g. `ENOTFOUND` or `CERT_HAS_EXPIRED`. */
function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Object; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
