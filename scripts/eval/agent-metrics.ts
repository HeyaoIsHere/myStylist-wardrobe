import type { AgentResult } from "../../src/lib/agent/types";
import type {
  AgentEvalCase,
  AgentEvalCaseResult,
  AgentEvalFailureMode,
  AgentEvalSummary,
  AgentMetricKind,
  AgentMetricStat,
} from "./agent-types";

/**
 * Pure metric computations for the Phase 6 AGENT eval. No I/O — given one
 * `AgentResult` + its golden expectation, produce the per-case record; given the
 * records, produce the aggregate. Trajectory verification is the core new
 * capability vs the Phase 5 final-answer-only eval.
 *
 * The mock deterministic policy makes trajectories EXACT. When the LLM decision
 * layer is evaluated (--provider deepseek), the trajectory assertion is relaxed
 * to "any of the six allowlisted tools completed the run" — the report marks it.
 */

const GHOST_RE = /^ghost-/;

/** empty-or-populated check for a constraints field. */
function nonEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null;
}

/** expected must-contain coverage over the parsed hard set. */
function missingConstraintValues(
  expected: AgentEvalCase["expected"]["hard"],
  parsed: AgentResult["hard"],
): string[] {
  const out: string[] = [];
  for (const [field, values] of Object.entries(expected)) {
    if (values === undefined || values === null) continue;
    const actual = (parsed as Record<string, unknown>)[field];
    const covered = Array.isArray(values)
      ? (values as string[]).every((v) => Array.isArray(actual) && (actual as string[]).includes(v))
      : actual === values;
    if (!covered) out.push(`${field}=[${Array.isArray(values) ? values.join(",") : String(values)}]`);
  }
  return out;
}

/** Deep-equal exact trajectory (ordered tool names). */
function sameTrajectory(traceTools: string[], expected: string[]): boolean {
  if (traceTools.length !== expected.length) return false;
  return traceTools.every((t, i) => t === expected[i]);
}

/**
 * The hard-preservation invariant: every search_wardrobe in the trace observed
 * the SAME effective constraint set (the search tool merges, never relaxes).
 * Returns the serialized constraint signatures, or null when <2 searches ran.
 */
function hardSignatures(result: AgentResult): (string | undefined)[] {
  return result.trace
    .filter((t) => t.tool === "search_wardrobe")
    .map((t) => (t.searchConstraints ? JSON.stringify(t.searchConstraints) : undefined));
}

export function evaluateAgentCase(def: AgentEvalCase, result: AgentResult): AgentEvalCaseResult {
  const trajectory = result.trace.map((t) => t.tool);
  const expectedTrajectory = def.expected.trajectory;
  const terminationMatch = def.expected.termination === "any" || result.terminationReason === def.expected.termination;
  const okMatch = result.ok === def.expected.ok;
  const itemIds = result.items.map((i) => i.id);

  const parsedHard = result.hard;
  const constraintMissing = missingConstraintValues(def.expected.hard, parsedHard);
  const expectedHardCount = Object.values(def.expected.hard).filter(nonEmpty).length;
  const constraintCoverage =
    expectedHardCount === 0 ? 1 : 1 - constraintMissing.length / expectedHardCount;

  const ghostIds = itemIds.filter((id) => GHOST_RE.test(id));
  const mustNotContainViolated = itemIds.filter((id) => (def.expected.mustNotContain ?? []).includes(id));

  // grounding: every returned item must be a live catalog id (never a ghost /
  // invented / duplicated id). The ≥2-piece look requirement only binds when a
  // look is actually expected (unsatisfiable / no-valid runs may finish empty by
  // design — the run's termination reason already asserts that intent).
  const seen = new Set<string>();
  let groundingBroken = false;
  for (const id of itemIds) {
    if (seen.has(id) || GHOST_RE.test(id)) {
      groundingBroken = true;
      break;
    }
    seen.add(id);
  }

  const signatures = hardSignatures(result);
  const hardStable =
    signatures.length < 2 ? true : signatures.every((s) => s === signatures[0]);
  const expectedHardStable = def.expected.hardStableAcrossSearches === true;

  const failureReasons: string[] = [];
  let failureMode: AgentEvalFailureMode | null = null;
  const fail = (mode: AgentEvalFailureMode, reason: string) => {
    if (!failureMode) failureMode = mode;
    failureReasons.push(reason);
  };

  if (!sameTrajectory(trajectory, [...expectedTrajectory])) {
    fail("trajectory-mismatch", `expected [${expectedTrajectory.join(" → ")}], got [${trajectory.join(" → ")}]`);
  }
  if (!terminationMatch) {
    fail("termination-mismatch", `expected termination ${def.expected.termination}, got ${result.terminationReason}`);
  }
  if (!okMatch) {
    fail("ok-mismatch", `expected ok=${def.expected.ok}, got ${result.ok}`);
  }
  if (constraintCoverage < 1) {
    fail("hard-coverage", `expected hard covers ${JSON.stringify(def.expected.hard)}; missing: ${constraintMissing.join(", ")}`);
  }
  if (!groundingBroken && def.expected.ok && itemIds.length < 2) {
    fail("grounding", `expected a ≥2-piece look, got ${itemIds.length}`);
  }
  if (groundingBroken) fail("grounding", "returned a duplicated or ghost id");
  if (mustNotContainViolated.length > 0) {
    fail("must-not-contain", `returned forbidden ids: ${mustNotContainViolated.join(",")}`);
  }
  if (expectedHardStable && !hardStable) {
    fail("hard-preservation", "hard constraints changed between searches");
  }

  return {
    caseId: def.id,
    lang: def.lang,
    tags: def.tags,
    query: def.query,
    seedGhosts: def.seedGhosts ?? [],
    ok: result.ok,
    expectedOk: def.expected.ok,
    termination: result.terminationReason,
    expectedTermination: def.expected.termination,
    terminationMatch,
    trajectory,
    expectedTrajectory,
    trajectoryMatch: sameTrajectory(trajectory, [...expectedTrajectory]),
    iterationCount: result.iterationCount,
    toolCallCount: result.toolCallCount,
    itemIds,
    itemCount: result.items.length,
    grounded: !groundingBroken && itemIds.length >= 2,
    parsedHard,
    constraintCoverage,
    constraintMissing,
    mustNotContainViolated,
    unreliableIds: ghostIds,
    hardStable,
    expectedHardStable,
    candidateCounts: result.trace
      .filter((t) => t.tool === "search_wardrobe")
      .map((t) => t.candidateCount ?? 0),
    latencyMs: result.durationMs,
    decisionProvider: result.decisionProvider,
    failureMode,
    failureReasons,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);

export function computeAgentSummary(cases: AgentEvalCaseResult[]): AgentEvalSummary {
  const metrics: AgentMetricStat[] = [];
  const p = (id: string, label: string, kind: AgentMetricKind, value: number, unit?: string) =>
    metrics.push({ id, label, kind, value, unit });

  // ── Deterministic ──
  p("agent_case_success_rate", "Exact-diagnostic success (failureMode === null, incl. trajectory)", "deterministic", pct(cases.map((c) => c.failureMode === null)), "ratio");
  p("trajectory_match_rate", "Exact tool-trajectory match", "deterministic", pct(cases.map((c) => c.trajectoryMatch)), "ratio");
  p("termination_match_rate", "Termination-reason match", "deterministic", pct(cases.map((c) => c.terminationMatch)), "ratio");
  p("ok_match_rate", "Final-ok match", "deterministic", pct(cases.map((c) => c.ok === c.expectedOk)), "ratio");
  p("groundedness_rate", "Grounded look rate (live ids, ≥2 pieces)", "deterministic", pct(cases.map((c) => c.grounded)), "ratio");
  p("stale_leak_rate", "Stale-vector leak rate (ghost id reaching the final items)", "deterministic", pct(cases.map((c) => c.unreliableIds.length > 0)), "ratio");
  p("hard_preservation_rate", "Hard-constraint stability across searches", "deterministic", pct(cases.map((c) => c.hardStable)), "ratio");
  p("hard_coverage_rate", "Hard-constraint parse coverage", "deterministic", mean(cases.map((c) => c.constraintCoverage)), "ratio");
  p("avg_iterations", "Average iterations per run", "deterministic", mean(cases.map((c) => c.iterationCount)), "iterations");
  p("avg_tool_calls", "Average tool calls per run", "deterministic", mean(cases.map((c) => c.toolCallCount)), "calls");

  // ── LLM-judged (meaningful only with a hosted decision layer) ──
  p("llm_decision_rate", "Decision provider is the LLM lane (not mock-policy)", "llm-judged", pct(cases.map((c) => c.decisionProvider !== "mock-policy")), "ratio");

  // ── Observability ──
  const lat = cases.map((c) => c.latencyMs).sort((a, b) => a - b);
  p("latency_p50", "Latency median", "observability", lat.length ? lat[Math.ceil(lat.length / 2) - 1] ?? 0 : 0, "ms");
  p("latency_mean", "Latency mean", "observability", mean(cases.map((c) => c.latencyMs)), "ms");
  p("latency_p95", "Latency p95", "observability", lat.length ? lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)] ?? 0 : 0, "ms");

  const byTag: Record<string, number> = {};
  for (const c of cases) for (const t of c.tags) byTag[t] = (byTag[t] ?? 0) + 1;

  return {
    totals: {
      caseCount: cases.length,
      en: cases.filter((c) => c.lang === "en").length,
      zh: cases.filter((c) => c.lang === "zh").length,
      byTag,
    },
    metrics,
  };
}

/** Compose the failures list used by both renderers (and the report object). */
export function collectAgentFailures(cases: AgentEvalCaseResult[]): { caseId: string; query: string; mode: AgentEvalFailureMode; reason: string }[] {
  return cases
    .filter((c) => c.failureMode !== null)
    .map((c) => ({ caseId: c.caseId, query: c.query, mode: c.failureMode!, reason: c.failureReasons.join("; ") }));
}