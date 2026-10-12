import type { PathSegment } from "./path.ts";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface MissingVariable {
  path: PathSegment[];
  name: string;
}

export interface ResolveResult {
  value: unknown;
  /** Values substituted from the environment. */
  secrets: string[];
  missing: MissingVariable[];
}

/**
 * Replaces `${VAR}` in every string value (not in keys) with `env[VAR]`. Unset variables are reported and left
 * in place. Substituted values are not scanned again, so a secret containing `${...}` stays literal.
 */
export function resolvePlaceholders(value: unknown, env: NodeJS.ProcessEnv): ResolveResult {
  const secrets: string[] = [];
  const missing: MissingVariable[] = [];

  const visit = (node: unknown, path: PathSegment[]): unknown => {
    if (typeof node === "string") {
      return node.replace(PLACEHOLDER, (match, name: string) => {
        const resolved = env[name];
        if (resolved === undefined) {
          missing.push({ path, name });
          return match;
        }
        secrets.push(resolved);
        return resolved;
      });
    }
    if (Array.isArray(node)) return node.map((item, index) => visit(item, [...path, index]));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item, [...path, key])]));
    }
    return node;
  };

  return { value: visit(value, []), secrets, missing };
}
