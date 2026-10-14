import type { RoleOutcome } from "../run.ts";
import { e } from "./escape.ts";

/** The pages of all runs together, in `report.json` and the HTML report. */
export interface ReportCoverage {
  /** Every page any run acted on, sorted by page. */
  pages: { page: string; steps: number; runs: number }[];
  /** Pages some run saw a link to and none acted on, sorted. */
  unvisited: string[];
}

/** Merges the coverage of every run that started. */
export function aggregateCoverage(outcomes: RoleOutcome[]): ReportCoverage {
  const pages = new Map<string, { steps: number; runs: number }>();
  const linked = new Set<string>();
  for (const { coverage } of outcomes) {
    if (coverage === undefined) continue;
    for (const { page, steps } of coverage.pages) {
      const entry = pages.get(page) ?? { steps: 0, runs: 0 };
      pages.set(page, { steps: entry.steps + steps, runs: entry.runs + 1 });
    }
    for (const page of coverage.unvisited) linked.add(page);
  }
  return {
    pages: [...pages.entries()]
      .map(([page, entry]) => ({ page, ...entry }))
      .sort((a, b) => a.page.localeCompare(b.page)),
    unvisited: [...linked].filter((page) => !pages.has(page)).sort(),
  };
}

/** The coverage section of `report.html`. */
export function coverageSection(coverage: ReportCoverage): string {
  const rows = coverage.pages
    .map(
      ({ page, steps, runs }) =>
        `      <tr><td><code>${e(page)}</code></td><td>${e(steps)}</td><td>${e(runs)}</td></tr>`,
    )
    .join("\n");
  const unvisited =
    coverage.unvisited.length === 0
      ? "<p>Every linked page that the runs may open was visited.</p>"
      : `<p>Linked but never visited:</p>\n  <ul>${coverage.unvisited.map((page) => `<li><code>${e(page)}</code></li>`).join("")}</ul>`;
  return `<section>
  <h2>Coverage</h2>
  <p class="meta">${e(coverage.pages.length)} page${coverage.pages.length === 1 ? "" : "s"} visited, by URL without query and ids.</p>
  <div class="scroll"><table>
    <thead><tr><th>Page</th><th>Steps</th><th>Runs</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
  ${unvisited}
</section>`;
}
