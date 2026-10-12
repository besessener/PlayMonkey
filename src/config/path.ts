export type PathSegment = string | number;

/** Formats a path like `auth[0].fields.password`; the empty path is `(root)`. */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (/^[A-Za-z_$][\w$]*$/.test(segment)) {
      out += out === "" ? segment : `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out === "" ? "(root)" : out;
}

/** Converts an Ajv `instancePath` (JSON Pointer) into path segments. */
export function pointerToSegments(pointer: string): PathSegment[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((raw) => {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
    });
}
