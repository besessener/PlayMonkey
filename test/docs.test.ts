import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configSchema } from "../src/config/schema.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Leaf key paths of the config schema, e.g. `limits.maxSteps`, `auth`, `auth[].name`. Free-form maps are leaves. */
function schemaPaths(schema: Record<string, unknown>, prefix = ""): string[] {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties === undefined) return [];
  return Object.entries(properties).flatMap(([key, child]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (child.type === "array" && child.items !== undefined && !Array.isArray(child.items)) {
      return [path, ...schemaPaths(child.items as Record<string, unknown>, `${path}[]`)];
    }
    // Objects with their own keys are documented through those keys.
    return child.properties === undefined ? [path] : schemaPaths(child, path);
  });
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("documentation", () => {
  it("documents every config key in docs/reference/configuration.md", () => {
    const doc = readFileSync(join(root, "docs/reference/configuration.md"), "utf8");
    const missing = schemaPaths(configSchema as unknown as Record<string, unknown>).filter(
      (path) => !doc.includes(`| \`${path}\` |`),
    );
    assert.deepEqual(missing, []);
  });

  it("has no broken relative links", () => {
    const files = [join(root, "README.md"), ...markdownFiles(join(root, "docs")), join(root, "fixtures/README.md")];
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (target === undefined || /^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const path = join(dirname(file), decodeURIComponent(target.split("#")[0] ?? ""));
        if (!existsSync(path)) broken.push(`${relative(root, file)} -> ${target}`);
      }
    }
    assert.deepEqual(broken, []);
  });
});
