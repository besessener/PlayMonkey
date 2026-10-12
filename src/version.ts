import { readFileSync } from "node:fs";

/** The package version. Resolves to the package root both from `src` (tests) and `dist` (built). */
export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
