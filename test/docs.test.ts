import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config/config.ts";
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

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, duplicates numbered. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const [, heading] of markdown.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = (heading ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return result;
}

/** Every file the docs test checks: the READMEs, CONTRIBUTING and docs/. */
function documentationFiles(): string[] {
  return [
    join(root, "README.md"),
    join(root, "CONTRIBUTING.md"),
    join(root, "CHANGELOG.md"),
    ...markdownFiles(join(root, "docs")),
    join(root, "fixtures/README.md"),
  ];
}

/** Every environment variable is set, to a value that also works as `baseUrl`: samples use `${ADMIN_PASS}` and such. */
const ANY_ENV = new Proxy(
  {},
  { get: (_, name) => (typeof name === "string" ? "https://test.example.org" : undefined) },
) as NodeJS.ProcessEnv;

describe("documentation", () => {
  it("documents every config key in docs/reference/configuration.md", () => {
    const doc = readFileSync(join(root, "docs/reference/configuration.md"), "utf8");
    const missing = schemaPaths(configSchema as unknown as Record<string, unknown>).filter(
      (path) => !doc.includes(`| \`${path}\` |`),
    );
    assert.deepEqual(missing, []);
  });

  it("has no broken relative links or anchors", () => {
    const broken: string[] = [];
    for (const file of documentationFiles()) {
      const markdown = readFileSync(file, "utf8");
      const text = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (target === undefined || /^[a-z]+:/i.test(target)) continue;
        const [pathPart = "", anchor] = target.split("#");
        const path = pathPart === "" ? file : join(dirname(file), decodeURIComponent(pathPart));
        if (!existsSync(path)) {
          broken.push(`${relative(root, file)} -> ${target}`);
        } else if (anchor !== undefined && path.endsWith(".md") && !anchors(readFileSync(path, "utf8")).has(anchor)) {
          broken.push(`${relative(root, file)} -> ${target} (no such heading)`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it("has sample configs that pass validation", () => {
    const samples: { where: string; json: string }[] = [];
    const configs = join(root, "fixtures/configs");
    for (const name of readdirSync(configs).filter((n) => n.endsWith(".json"))) {
      samples.push({ where: `fixtures/configs/${name}`, json: readFileSync(join(configs, name), "utf8") });
    }
    for (const file of documentationFiles()) {
      for (const [, json] of readFileSync(file, "utf8").matchAll(/```json\n([\s\S]*?)```/g)) {
        // Whole configs only; snippets of one section have no baseUrl.
        if (json === undefined || !/^\{\s*"(\$schema|baseUrl)"/.test(json.trim())) continue;
        samples.push({ where: relative(root, file), json: json.replace(/<[a-z-]+>/g, "x") });
      }
    }
    assert.ok(samples.length >= 5, `only ${samples.length} samples found`);
    const invalid: string[] = [];
    for (const { where, json } of samples) {
      try {
        parseConfig(json, { env: ANY_ENV, source: where });
      } catch (error) {
        invalid.push((error as Error).message);
      }
    }
    assert.deepEqual(invalid, []);
  });

  it("has a changelog section for the package version, as the release workflow needs", () => {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.includes(`\n## ${version} – `), `CHANGELOG.md has no "## ${version} – <date>" section`);
  });

  it("shows the CI example workflow exactly as it runs in this repository", () => {
    const workflow = readFileSync(join(root, ".github/workflows/monkey.yml"), "utf8");
    const doc = readFileSync(join(root, "docs/how-to/run-in-ci.md"), "utf8");
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map(([, block]) => block);
    assert.ok(blocks.includes(workflow), "docs/how-to/run-in-ci.md must contain .github/workflows/monkey.yml verbatim");
  });
});
