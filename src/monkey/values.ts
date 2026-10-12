import type { SnapshotElement } from "../snapshot/snapshot.ts";
import type { Random } from "./random.ts";

/** Inputs that commonly break validation, rendering or storage. */
export const NASTY_VALUES: readonly string[] = [
  "",
  "   ",
  "x".repeat(10_000),
  "Zoë 日本語 🐒 مرحبا בעולם",
  "‮evil‬",
  "!@#$%^&*()_+-=[]{}|;':\",./<>?`~\\",
  "<script>console.log('monkey')</script>",
  '"><img src=x onerror=console.log(1)>',
  "' OR '1'='1",
  "-1",
  "0",
  "99999999999999999999",
  "3.14159e308",
  "NaN",
  "2026-02-30",
  "null",
  "\n\n\n",
];

/** Plain values for fields without matching test data, so forms can also be submitted successfully. */
const PLAIN_VALUES: readonly string[] = ["Monkey", "monkey test", "42", "monkey@test.local"];

const VALID_SHARE = 0.5;

/**
 * Picks a value for a text field: about half the time a valid one (test data whose key matches the field's name or
 * placeholder, otherwise a plain value), else one of the nasty values.
 */
export function chooseFillValue(element: SnapshotElement, testData: Record<string, string>, random: Random): string {
  if (random.chance(VALID_SHARE)) {
    const matching = matchingTestData(element, testData);
    return matching.length > 0 ? random.pick(matching) : random.pick(PLAIN_VALUES);
  }
  return random.pick(NASTY_VALUES);
}

/** Test data values whose key appears in the field's name or placeholder, e.g. key `email` for "E-Mail address". */
export function matchingTestData(element: SnapshotElement, testData: Record<string, string>): string[] {
  const label = normalize(`${element.name} ${element.placeholder ?? ""}`);
  return Object.keys(testData)
    .sort()
    .filter((key) => {
      const normalized = normalize(key);
      return normalized !== "" && label.includes(normalized);
    })
    .map((key) => testData[key] as string);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}
