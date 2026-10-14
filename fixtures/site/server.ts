import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { type Credentials, createRoutes, notFound, type Request, type Response, serverError } from "./pages.ts";

/** Test credentials accepted by `/login` unless overridden. */
export const FIXTURE_CREDENTIALS: Credentials = { username: "monkey", password: "banana-split" };

export interface FixtureOptions {
  /** Port to listen on; 0 (default) picks a free one. */
  port?: number;
  credentials?: Credentials;
}

export interface Fixture {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:41234`. */
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Starts the fixture site on 127.0.0.1. Each instance has its own sessions. */
export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const routes = createRoutes({ credentials: options.credentials ?? FIXTURE_CREDENTIALS, sessions: new Map() });

  const server = createServer((req, res) => {
    void toRequest(req)
      .then((request) => {
        const route = routes.find((r) => r.method === request.method && r.path === request.url.pathname);
        return route === undefined ? notFound() : route.handle(request);
      })
      .catch(() => serverError())
      .then((response: Response) => {
        if (response.hold === true) return;
        if (response.reset === true) {
          res.destroy();
          return;
        }
        res.writeHead(response.status, response.headers);
        if (response.abort === true) {
          res.write(response.body ?? "");
          // Let the first bytes arrive, then drop the connection mid-body.
          setTimeout(() => res.destroy(), 50);
          return;
        }
        res.end(response.body);
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  const method = req.method ?? "GET";
  let body = "";
  if (method === "POST") {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) throw new Error("body too large");
    }
  }
  return {
    method,
    url,
    host: req.headers.host ?? "",
    cookies: parseCookies(req.headers.cookie),
    form: new URLSearchParams(body),
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}
