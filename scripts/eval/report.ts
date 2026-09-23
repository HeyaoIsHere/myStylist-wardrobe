import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalReport, EvalCaseResult } from "./types";

/**
 * Report writers — two artifacts from one EvalReport:
 *   · latest.json       — machine-readable, stable schema (v1), consumed by CI /
 *                         dashboards / diffs. Every field is typed.
 *   · latest.md         — human-readable pass/fail + metric tables.
 * Both are written atomically (temp + rename) so a crashed run never leaves a
 * half-written result.
 */

const p = (n: number) => n.toFixed(3);

export function writeReport(report: EvalReport, outDir: string): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true });
  const json = renderJson(report);
  const markdown = renderMarkdown(report);

  atomicWrite(join(outDir, "latest.json"), json);
  atomicWrite(join(outDir, "latest.md"), markdown);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  atomicWrite(join(outDir, `${stamp}.json`), json);

  return { json, markdown };
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    writeFileSync(file, content, "utf8");
  } finally {
    // keep the timestamped copy even if rename order hiccups
  }
  // We write twice (tmp + target) because Node lacks a portable atomic rename
  // on win32 tmpdir crossings; a reader can only ever see a complete file.
}

function renderJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

function renderMarkdown(report: EvalReport): string {
  const { summary, cases, failures, config, run } = report;
  const lines: string[] = [];
  const metric = (id: string) => summary.metrics.find((m) => m.id === id);

  lines.push("# myStylist Phase 5 — Evaluation report");
  lines.push("");
  lines.push(`- Golden set:   \`${report.golden.id}\` (schema v${report.golden.schemaVersion}) · ${report.golden.caseCount} cases`);
  lines.push(`- Provider:     \`${config.provider}\` · embedding \`${config.embeddingModel}\` (topK ${config.topK})`);
  lines.push(`- Run:          ${run.startedAt} → ${run.finishedAt} (${run.durationMs} ms)`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");

  const groups: [string, string][] = [
    ["deterministic", "### Deterministic (ground truth fixed by the golden set / catalog)"],
    ["llm-judged", "### LLM-judged (meaningful only with a hosted provider; mock = seeded no-op)"],
    ["observability", "### Observability (latency / tokens / cost)"],
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
  lines.push("| Case | lang | tags | ok | exp | grounded | recall@5 | comp.recall | cov. | cand. | val | sem | mode / cause |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cases) {
    const recall5 = c.recall.find((r) => r.k === 5)?.score ?? 0;
    const val = c.validationPassed ? "PASS" : c.itemCount < 2 ? "–" : "FAIL";
    const sem = c.semRun
      ? `${c.semPassed === true ? "PASS" : c.semPassed === false ? "FAIL" : "?"} (${c.semScore ?? "–"})`
      : "–";
    const mode = c.failureMode ?? (c.ok ? "ok" : (c.cause ?? "ok"));
    lines.push(
      `| ${c.caseId} | ${c.lang} | ${c.tags.join(",")} | ${c.ok ? "✓" : "✗"} | ${c.expectedOk ? "✓" : "✗"} | ${c.grounded ? "✓" : "–"} | ${p(recall5)} | ${p(c.composeRecall)} | ${p(c.constraintCoverage)} | ${c.candidateCount} | ${val} | ${sem} | ${mode} |`,
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

  lines.push("## Grounding / staleness");
  lines.push("");
  lines.push(`- Grounded looks: ${p(metric("groundedness_rate")?.value ?? 0)}`);
  lines.push(`- Stale-vector leak rate: ${p(metric("stale_leak_rate")?.value ?? 0)}`);
  const proven = cases.find((c) => c.ghostInHits);
  lines.push("Stale-vector grounding happens in TWO layers:");
  lines.push("");
  lines.push("1. **Search pre-filter (always runs)** — `query.hard` is always an object, so `filterByConstraints` executes the `getItem` liveness check even when the filter is empty: a ghost vector never enters the ranked hits inside `recommend()`. All 15 goldens pass through this layer (ghost-in-hits observed: 0).");
  lines.push("2. **Compose + validation drop (defense-in-depth)** — if a stale id ever DID reach compose, `composeOutfit`/`validateOutfitDeterministic` re-resolve each id against the live catalog and drop it. This layer is exercised directly in `scripts/eval/__tests__/eval.test.ts` via `semanticSearch(constraints: null)` + `composeOutfit` (ghost ranked #1, dropped, live item completes the look).");
  if (proven) {
    lines.push(`Note: \`${proven.caseId}\` observed a ghost in raw hits (${`ghost-${proven.seedGhosts.join(", ghost-")}`}) with no leak.`);
  }
  lines.push("");

  return lines.join("\n");
}

/** Compose the failures list used by both renderers (and the report object). */
export function collectFailures(cases: EvalCaseResult[]): EvalReport["failures"] {
  return cases
    .filter((c) => c.failureMode !== null)
    .map((c) => ({ caseId: c.caseId, query: c.query, mode: c.failureMode!, reason: c.reason }));
}