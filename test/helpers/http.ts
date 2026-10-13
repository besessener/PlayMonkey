export interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type MockAnswer = Response | Error | ((init?: RequestInit) => Promise<Response>);

/** A fetch that answers with the given responses in turn and records every request. */
export function mockFetch(...responses: MockAnswer[]): { fetch: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  // A throw inside the executor rejects the promise, as a real fetch does.
  const fetch = ((resource: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      requests.push({
        url: String(resource),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      resolve(typeof next === "function" ? next(init) : next);
    })) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** A JSON response; `retry-after-ms: 1` keeps SDK retries fast. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "1", ...headers },
  });
}

/** What fetch throws when the host cannot be reached, with the network code as cause. */
export function connectionError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}
