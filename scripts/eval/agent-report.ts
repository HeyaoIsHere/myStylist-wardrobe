import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvalReport, AgentEvalCaseResult } from "./agent-types";

/**
 * Report writers for the Phase 6 AGENT eval — two artifacts from one report:
 *   · latest.json  — machine-readable, stable schema (v1).
 *   · latest.md    — human-readable per-case trajectory + termination tables.
 * Atomic write discipline identical to the Phase 5 report.
 */

const p = (n: number) => n.toFixed(3);

export function writeAgentReport(report: AgentEvalReport, outDir: string): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const markdown = renderAgentMarkdown(report);
  atomicWrite(join(outDir, "latest-agent.json"), json);
  atomicWrite(join(outDir, "latest-agent.md"), markdown);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  atomicWrite(join(outDir, `${stamp}-agent.json`), json);
  return { json, markdown };
}

function atomicWrite(file: string, content: string): void {
  writeFileSync(`${file}.tmp`, content, "utf8");
  writeFileSync(file, content, "utf8");
}

function renderAgentMarkdown(report: AgentEvalReport): string {
  const { summary, cases, failures, config, run } = report;
  const lines: string[] = [];
  const metric = (id: string) => summary.metrics.find((m) => m.id === id);

  lines.push("# myStylist Phase 6 — Bounded agent evaluation report");
  lines.push("");
  lines.push(`- Golden set:   \`${report.golden.id}\` (schema v${report.golden.schemaVersion}) · ${report.golden.caseCount} cases`);
  lines.push(`- Provider:     \`${config.provider}\` · decision layer: \`${config.decision}\``);
  lines.push(`- Run:          ${run.startedAt} → ${run.finishedAt} (${run.durationMs} ms)`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");

  const groups: [string, string][] = [
    ["deterministic", "### Deterministic (trajectories are exact under the mock policy)"],
    ["llm-judged", "### LLM-judged (presence of the hosted decision lane)"],
    ["observability", "### Observability (latency)"],
  ];
  for (const [kind, header] of groups) {
    lines.push(header);
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|---|---|");
    for (const m of summary.metrics.filter((x) => x.kind === kind)) {
      const unit = m.unit ? ` ${m.unit}` : "";
      lines.push(`| ${m.label} | **${p(m.value)}**${unit} |`);
    }
    lines.push("");
  }

  lines.push("## Dataset coverage");
  lines.push("");
  lines.push(`- Total ${summary.totals.caseCount} cases · ${summary.totals.en} en · ${summary.totals.zh} zh`);
  lines.push(`- Per tag: ${Object.entries(summary.totals.byTag).map(([t, n]) => `${t}=${n}`).join(" · ")}`);
  lines.push("");

  lines.push("## Per-case results");
  lines.push("");
  lines.push("| Case | tags | ok | exp | traj | term | iters | calls | items | hard | mode |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cases) {
    const traj = c.trajectoryMatch ? "✓" : `✗ ([[${c.expectedTrajectory.join(" → ")}]])`;
    const term = c.terminationMatch ? c.termination : `✗ ${c.termination} (want ${c.expectedTermination})`;
    lines.push(
      `| ${c.caseId} | ${c.tags.join(",")} | ${c.ok ? "✓" : "✗"} | ${c.expectedOk ? "✓" : "✗"} | ${traj} | ${term} | ${c.iterationCount} | ${c.toolCallCount} | ${c.itemCount} | ${p(c.constraintCoverage)} | ${c.failureMode ?? "ok"} |`,
    );
  }
  lines.push("");

  lines.push("## Failures & findings (failureMode ≠ null)");
  lines.push("");
  if (failures.length === 0) {
    lines.push("_None — every case matched its expectation._");
  } else {
    lines.push("| Case | mode | reason |");
    lines.push("|---|---|---|");
    for (const f of failures) {
      lines.push(`| ${f.caseId} | ${f.mode} | ${f.reason} |`);
    }
  }
  lines.push("");

  lines.push("## What trajectory verification proves");
  lines.push("");
  lines.push("Exact-tool assertions are only valid for the **deterministic mock decision policy**:");
  lines.push(`- \`trajectory_match_rate\`: ${p(metric("trajectory_match_rate")?.value ?? 0)}`);
  lines.push(`- \`termination_match_rate\`: ${p(metric("termination_match_rate")?.value ?? 0)}`);
  lines.push(`- \`hard_preservation_rate\`: ${p(metric("hard_preservation_rate")?.value ?? 0)}`);
  lines.push(`- \`stale_leak_rate\`: ${p(metric("stale_leak_rate")?.value ?? 0)}`);
  lines.push("");
  lines.push("The six allowlisted tools are the ONLY tools the run can execute (zod discriminated-union allowlist in the runner). An unknown action fails structural validation and the run terminates `invalid-tool-call`.");

  return lines.join("\n");
}

/** Compose the failures list (shared by both renderers). */
export function collectAgentFailures(cases: AgentEvalCaseResult[]): AgentEvalReport["failures"] {
  return cases
    .filter((c) => c.failureMode !== null)
    .map((c) => ({ caseId: c.caseId, query: c.query, mode: c.failureMode!, reason: c.failureReasons.join("; ") }));
}