import type { PathSegment } from "./path.ts";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface MissingVariable {
  path: PathSegment[];
  name: string;
}

/** A value substituted from the environment, with the variable it came from. */
export interface SecretValue {
  name: string;
  value: string;
}

/** A value substituted from the environment, with where in the document it was substituted. */
export interface SubstitutedValue extends SecretValue {
  path: PathSegment[];
}

export interface ResolveResult {
  value: unknown;
  /** Values substituted from the environment. */
  secrets: SubstitutedValue[];
  missing: MissingVariable[];
}

/**
 * Replaces `${VAR}` in every string value (not in keys) with `env[VAR]`. Unset variables are reported and left
 * in place. Substituted values are not scanned again, so a secret containing `${...}` stays literal. With `names`,
 * only those variables are replaced; other `${...}` text is left alone.
 */
export function resolvePlaceholders(
  value: unknown,
  env: NodeJS.ProcessEnv,
  names?: ReadonlySet<string>,
): ResolveResult {
  const secrets: SubstitutedValue[] = [];
  const missing: MissingVariable[] = [];

  const visit = (node: unknown, path: PathSegment[]): unknown => {
    if (typeof node === "string") {
      return node.replace(PLACEHOLDER, (match, name: string) => {
        if (names !== undefined && !names.has(name)) return match;
        const resolved = env[name];
        if (resolved === undefined) {
          missing.push({ path, name });
          return match;
        }
        secrets.push({ name, value: resolved, path });
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
