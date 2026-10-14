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
    ...markdownFiles(join(root, "docs")),
    join(root, "fixtures/README.md"),
  ];
}

/** Every environment variable is set, to a value that also works as `baseUrl`: samples use `${ADMIN_PASS}` and such. */
const ANY_ENV = new Proxy(
  {},
  { get: (_, name) => (typeof name === "string" ? "https://test.example.org" : undefined) },
) as NodeJS.ProcessEnv;

/** Why the link `target` in `file` is broken, or undefined when it resolves. External links are not checked. */
function linkProblem(file: string, target: string): string | undefined {
  if (/^[a-z]+:/i.test(target)) return undefined;
  const [pathPart = "", anchor] = target.split("#");
  const path = pathPart === "" ? file : join(dirname(file), decodeURIComponent(pathPart));
  if (!existsSync(path)) return `${relative(root, file)} -> ${target}`;
  if (anchor !== undefined && path.endsWith(".md") && !anchors(readFileSync(path, "utf8")).has(anchor)) {
    return `${relative(root, file)} -> ${target} (no such heading)`;
  }
  return undefined;
}

/** Broken relative links and anchors of one markdown file, ignoring code. */
function brokenLinks(file: string): string[] {
  const markdown = readFileSync(file, "utf8");
  const text = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].flatMap(([, target]) => {
    const problem = target === undefined ? undefined : linkProblem(file, target);
    return problem === undefined ? [] : [problem];
  });
}

interface Sample {
  where: string;
  json: string;
}

/** Whole sample configs in the json blocks of a markdown file, with placeholders like `<host>` filled in. */
function documentedSamples(file: string): Sample[] {
  return [...readFileSync(file, "utf8").matchAll(/```json\n([\s\S]*?)```/g)].flatMap(([, json]) => {
    // Whole configs only; snippets of one section have no baseUrl.
    if (json === undefined || !/^\{\s*"(\$schema|baseUrl)"/.test(json.trim())) return [];
    return [{ where: relative(root, file), json: json.replace(/<[a-z-]+>/g, "x") }];
  });
}

/** The sample configs under fixtures/configs and demo/, then those in the documentation. */
function sampleConfigs(): Sample[] {
  const files = ["fixtures/configs", "demo"].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${dir}/${name}`),
  );
  const configs = files.map((where) => ({ where, json: readFileSync(join(root, where), "utf8") }));
  return [...configs, ...documentationFiles().flatMap(documentedSamples)];
}

/** The validation error of a sample, if it has one. */
function validationErrors({ where, json }: Sample): string[] {
  try {
    parseConfig(json, { env: ANY_ENV, source: where });
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}

describe("documentation", () => {
  it("documents every config key in docs/reference/konfiguration.md", () => {
    const doc = readFileSync(join(root, "docs/reference/konfiguration.md"), "utf8");
    const missing = schemaPaths(configSchema as unknown as Record<string, unknown>).filter(
      (path) => !doc.includes(`| \`${path}\` |`),
    );
    assert.deepEqual(missing, []);
  });

  it("has no broken relative links or anchors", () => {
    assert.deepEqual(documentationFiles().flatMap(brokenLinks), []);
  });

  it("has sample configs that pass validation", () => {
    const samples = sampleConfigs();
    assert.ok(samples.length >= 5, `only ${samples.length} samples found`);
    assert.deepEqual(samples.flatMap(validationErrors), []);
  });

  it("shows the CI example workflow exactly as it runs in this repository", () => {
    const workflow = readFileSync(join(root, ".github/workflows/monkey.yml"), "utf8");
    const doc = readFileSync(join(root, "docs/how-to/in-ci-ausfuehren.md"), "utf8");
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map(([, block]) => block);
    assert.ok(
      blocks.includes(workflow),
      "docs/how-to/in-ci-ausfuehren.md must contain .github/workflows/monkey.yml verbatim",
    );
  });
});
