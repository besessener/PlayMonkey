import type { LlmReport, LlmSummary } from "../llm/usage.ts";
import type { ActionContext } from "../oracles/finding.ts";
import type { AggregatedFinding, Report, ReportFinding, RoleSummary } from "./report.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and attribute values. Every dynamic value in the report goes through this. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const e = (value: unknown) => escapeHtml(String(value));

/**
 * One self-contained HTML file: inline CSS, screenshots as data URIs, no scripts and nothing loaded from the
 * network. Traces, videos and action logs are linked relative to the report directory.
 */
export function renderHtml(report: Report, screenshots: Map<string, string>): string {
  const total = report.aggregated.length;
  const seeds = report.seeds === undefined ? `seed ${e(report.seed)}` : `seeds ${e(report.seeds.join(", "))}`;
  const counts = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `<span class="badge ${e(severity)}">${e(count)} ${e(severity)}</span>`)
    .join(" ");
  const baseUrl = (report.config as { baseUrl?: unknown }).baseUrl;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PlayMonkey report</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>PlayMonkey report</h1>
  <p class="meta">${e(baseUrl ?? "")} · ${seeds} · ${e(report.startedAt)} · playmonkey ${e(report.tool.version)}</p>
  <p class="total">${total === 0 ? "No findings." : `${e(total)} finding${total === 1 ? "" : "s"} ${counts}`}</p>
</header>
<main>
<section>
  <h2>Runs</h2>
  <div class="scroll"><table>
    <thead><tr><th>Role</th><th>Seed</th><th>Steps</th><th>Duration</th><th>Stopped</th><th>Findings</th><th>Artifacts</th></tr></thead>
    <tbody>
${report.roles.map(roleRow).join("\n")}
    </tbody>
  </table></div>
</section>
${report.llm === undefined ? "" : llmSection(report.llm)}
<section>
  <h2>Findings</h2>
${total === 0 ? '  <p class="empty">The oracles found nothing.</p>' : report.aggregated.map((f) => findingCard(f, report, screenshots)).join("\n")}
</section>
<footer>
  <p>Open a trace with <code>npx playwright show-trace &lt;trace.zip&gt;</code>. Repeat a run with
  <code>monkey replay &lt;actions.json&gt; --config &lt;config.json&gt;</code>, using the run's action log.</p>
</footer>
</main>
</body>
</html>
`;
}

function llmSection(llm: LlmReport): string {
  const notes: string[] = [];
  if (llm.status === "disabled")
    notes.push(`LLM disabled: ${e(llm.disabledReason ?? "")}; the run was a pure random monkey.`);
  if (llm.budget.exhausted !== undefined) {
    const { role, step, reason } = llm.budget.exhausted;
    notes.push(
      `Budget exhausted at step ${e(step)} of role ${e(role)}: ${e(reason)}; the rest of the run was a pure random monkey.`,
    );
  }
  const rows = [{ role: "Total", ...llm.total }, ...llm.roles].map(llmRow).join("\n");
  const cost =
    llm.total.estimatedCost === undefined ? "" : `<th title="Estimate from llm.pricing, not a bill">Est. cost</th>`;
  return `<section>
  <h2>LLM usage</h2>
  <p class="meta">${e(llm.provider)} · deployment <code>${e(llm.deployment)}</code>${llm.preflight === undefined ? "" : ` · preflight ${llm.preflight.ok ? `ok (${e(llm.preflight.latencyMs ?? 0)} ms)` : `failed: ${e(llm.preflight.error ?? "")}`}`}</p>
  ${notes.map((note) => `<p class="note">${note}</p>`).join("\n  ")}
  <div class="scroll"><table>
    <thead><tr><th>Role</th><th>Calls</th><th>Failed</th><th>Input</th><th>Output</th><th>Cached</th><th>Retries</th><th>Handoffs</th><th>LLM actions</th><th>Fallbacks</th><th>Breaker</th><th>Latency avg / p95</th>${cost}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
  ${llm.total.estimatedCost === undefined ? "" : '<p class="meta">Costs are estimates from <code>llm.pricing</code>, not a bill.</p>'}
</section>`;
}

function llmRow(row: LlmSummary & { role: string }): string {
  const counts = (map: Partial<Record<string, number>>) => {
    const entries = Object.entries(map).filter(([, count]) => (count ?? 0) > 0);
    const total = entries.reduce((sum, [, count]) => sum + (count ?? 0), 0);
    return entries.length === 0
      ? "0"
      : `${e(total)} <span class="on">(${entries.map(([k, c]) => `${e(k)} ${e(c)}`).join(", ")})</span>`;
  };
  const cost = row.estimatedCost === undefined ? "" : `<td>≈ ${e(row.estimatedCost.toFixed(4))}</td>`;
  return `      <tr><td>${e(row.role)}</td><td>${e(row.calls)}</td><td>${counts(row.errors)}</td><td>${e(row.inputTokens)}</td><td>${e(row.outputTokens)}</td><td>${e(row.cachedTokens)}</td><td>${e(row.retries)}</td><td>${counts(row.handoffs)}</td><td>${e(row.actions)}</td><td>${counts(row.fallbacks)}</td><td>${e(row.breakerTrips)}</td><td>${e(row.avgLatencyMs)} / ${e(row.p95LatencyMs)} ms</td>${cost}</tr>`;
}

function stopCell(role: RoleSummary): string {
  if (role.stopReason === undefined) return `<span class="badge critical">did not start</span> ${e(role.error ?? "")}`;
  if (role.stopReason === "error") return `<span class="badge critical">error</span> ${e(role.error ?? "")}`;
  return e(role.stopReason);
}

function roleRow(role: RoleSummary): string {
  const stopped = stopCell(role);
  const links = [
    role.actionLog === undefined ? "" : link(role.actionLog, "actions"),
    role.trace === undefined ? "" : link(role.trace, "trace"),
    ...role.videos.map((video, index) => link(video, role.videos.length > 1 ? `video ${index + 1}` : "video")),
  ]
    .filter((item) => item !== "")
    .join(" · ");
  return `      <tr id="${e(runId(role.role, role.seed))}"><td>${e(role.role)}</td><td>${e(role.seed)}</td><td>${e(role.steps ?? "–")}</td><td>${role.durationMs === undefined ? "–" : `${e((role.durationMs / 1000).toFixed(1))} s`}</td><td>${stopped}</td><td>${e(role.findings)}</td><td>${links}</td></tr>`;
}

function findingCard(group: AggregatedFinding, report: Report, screenshots: Map<string, string>): string {
  // The first run that found it supplies the steps, screenshot and details.
  const [first] = group.runs;
  const finding = report.findings.find(
    (f) => f.key === group.key && f.role === first?.role && f.seed === first.seed,
  ) as ReportFinding;
  const role = report.roles.find((r) => r.role === finding.role && r.seed === finding.seed);
  const image = finding.screenshot === undefined ? undefined : screenshots.get(finding.screenshot);
  const links = [
    role?.actionLog === undefined ? "" : link(role.actionLog, "actions.json"),
    role?.trace === undefined ? "" : link(role.trace, "trace"),
    ...(role?.videos ?? []).map((video) => link(video, "video")),
  ]
    .filter((item) => item !== "")
    .join(" · ");
  const multiSeed = report.seeds !== undefined;
  const runs = group.runs
    .map(
      (run) =>
        `<a href="#${e(runId(run.role, run.seed))}">${e(run.role)}${multiSeed ? ` seed ${e(run.seed)}` : ""}</a> ${e(run.id)}`,
    )
    .join(", ");
  const where = multiSeed ? ` · seed ${e(finding.seed)}` : "";
  return `  <article class="finding" id="${e(group.key)}">
    <h3><span class="badge ${e(group.severity)}">${e(group.severity)}</span> <code>${e(group.oracle)}</code> ${e(group.message)}</h3>
    <dl>
      <dt>Where</dt><dd><code>${e(group.url)}</code></dd>
      <dt>Found in</dt><dd>${e(group.roles.join(", "))} · seen ${e(group.occurrences)}×${group.runs.length > 1 ? ` in ${e(group.runs.length)} runs` : ""}</dd>
      <dt>Runs</dt><dd>${runs}</dd>
      <dt>Shown</dt><dd>${e(finding.role)}${where} · ${e(finding.id)} · first at step ${e(finding.step)} · seen ${e(finding.occurrences)}×</dd>
      ${links === "" ? "" : `<dt>Artifacts</dt><dd>${links}</dd>`}
    </dl>
    <div class="body">
      <div>
        <h4>Steps to reproduce</h4>
        ${
          finding.lastActions.length === 0
            ? "<p>Found before the first action, on the start page.</p>"
            : `<ol start="${e(finding.lastActions[0]?.step ?? 1)}">${finding.lastActions.map((action) => `<li>${describeStep(action)}</li>`).join("")}</ol>`
        }
        <details><summary>Details</summary><pre>${e(JSON.stringify({ key: finding.key, ...finding.details }, null, 2))}</pre></details>
      </div>
      ${image === undefined ? "" : `<img class="shot" src="${e(image)}" alt="Screenshot at step ${e(finding.step)}">`}
    </div>
  </article>`;
}

/** Anchor of a run's row in the runs table. */
function runId(role: string, seed: number): string {
  return `run-${role}-${seed}`;
}

/** A repro step in words, with the durable locator so it can be found by hand or in Playwright. */
export function describeStep(entry: ActionContext): string {
  const { action } = entry;
  const target = entry.locator === undefined ? "" : ` <code>${e(entry.locator)}</code>`;
  const quote = (text: string) => `<q>${e(text.length > 80 ? `${text.slice(0, 79)}…` : text)}</q>`;
  const where = ` <span class="on">on ${e(pathOf(entry.url))}</span>`;
  switch (action.type) {
    case "click":
      return `Click${target}${where}`;
    case "dblclick":
      return `Double-click${target}${where}`;
    case "rightclick":
      return `Right-click${target}${where}`;
    case "hover":
      return `Hover over${target}${where}`;
    case "longPress":
      return `Press and hold${target}${where}`;
    case "drag": {
      const to = entry.toLocator === undefined ? "" : ` onto <code>${e(entry.toLocator)}</code>`;
      return `Drag${target}${to}${where}`;
    }
    case "fill":
      return `Fill${target} with ${quote(action.value)}${where}`;
    case "select":
      return `Select ${quote(action.value)} in${target}${where}`;
    case "check":
      return `Check${target}${where}`;
    case "uncheck":
      return `Uncheck${target}${where}`;
    case "press":
      return `Press <kbd>${e(action.key)}</kbd>${where}`;
    case "scroll":
      return `Scroll ${action.deltaY > 0 ? "down" : "up"} ${e(Math.abs(action.deltaY))} px${where}`;
    case "back":
      return `Go back${where}`;
    case "navigate":
      return `Open <code>${e(action.url)}</code>`;
    case "setViewport":
      return `Resize the window to ${e(action.width)}×${e(action.height)}${where}`;
    case "switchTab":
      return `Switch to tab ${e(action.index + 1)}`;
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    // Masked URLs (`***/form`) are not absolute.
    return url;
  }
}

function link(href: string, label: string): string {
  return `<a href="${e(encodeURI(href))}">${e(label)}</a>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafaf9; --card: #fff; --text: #1c1917; --muted: #57534e; --line: #e7e5e4;
  --code: #f5f5f4; --critical: #7f1d1d; --high: #b91c1c; --medium: #b45309; --low: #1d4ed8; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --card: #292524; --text: #f5f5f4; --muted: #a8a29e; --line: #44403c; --code: #1c1917;
    --critical: #fca5a5; --high: #f87171; --medium: #fbbf24; --low: #93c5fd; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
header, main { max-width: 1100px; margin: 0 auto; padding: 1.25rem 16px; }
header { border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 1.5rem; }
h2 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; }
h3 { font-size: 1rem; margin: 0 0 0.5rem; overflow-wrap: anywhere; }
h4 { font-size: 0.9rem; margin: 0.75rem 0 0.25rem; color: var(--muted); }
.meta, .on, footer, .empty { color: var(--muted); }
.note { border-left: 3px solid var(--medium); padding-left: 0.6rem; }
.meta { margin: 0.25rem 0; overflow-wrap: anywhere; }
.total { margin: 0.5rem 0 0; font-weight: 600; }
code, kbd, pre { font: 0.85em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 4px; }
code, kbd { padding: 0.05em 0.3em; overflow-wrap: anywhere; }
pre { padding: 0.75rem; overflow-x: auto; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: var(--card); }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.badge { display: inline-block; padding: 0 0.45em; border-radius: 999px; font-size: 0.8em; font-weight: 600;
  color: var(--card); background: var(--muted); text-transform: uppercase; letter-spacing: 0.02em; }
.badge.critical { background: var(--critical); } .badge.high { background: var(--high); }
.badge.medium { background: var(--medium); } .badge.low { background: var(--low); }
.finding { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 360px); gap: 1rem; }
ol { margin: 0; padding-left: 2.5rem; }
li { margin: 0.15rem 0; overflow-wrap: anywhere; }
img.shot { width: 100%; border: 1px solid var(--line); border-radius: 4px; margin-top: 0.75rem; }
a { color: var(--low); }
@media (max-width: 720px) { .body { grid-template-columns: 1fr; } }
`;
