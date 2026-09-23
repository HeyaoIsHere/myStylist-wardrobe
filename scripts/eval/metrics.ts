import type { OutfitRecommendation } from "../../src/lib/recommend/types";
import type { EvalCase, EvalCaseResult, EvalFailureMode, EvalSummary, MetricStat } from "./types";

/**
 * Pure metric computations for the Phase 5 eval. No I/O, no running the
 * pipeline — given a recommendation result + its golden expectation, produce
 * the per-case numbers; given the per-case numbers, produce the aggregate.
 *
 * Deterministic vs LLM-judged: metrics whose ground truth is fixed by the
 * golden/catalog (recall, constraints, grounding, validation-guard outcomes,
 * e2e verdict) are `deterministic`. Metrics that depend on model judgment
 * (parsed intent, advisory-semantic verdicts) are `llm-judged` — they can only
 * be interpreted when a hosted provider is in use; the mock has no real
 * linguistic judgment. Latency/cost/tokens are `observability`.
 */

const GHOST_RE = /^ghost-/;

/** equality subset check for one MetadataConstraints field. */
function covered(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (left as string[]).every((v) => (right as string[]).includes(v));
  }
  if (left === undefined) return true; // golden expects nothing on this field
  return left === right;
}

/** One field.name → the expected values that the parsed result MISSED. */
export function missingConstraintValues(
  expected: NonNullable<EvalCase["expected"]>["hard"],
  parsed: OutfitRecommendation["query"]["hard"],
): string[] {
  const out: string[] = [];
  for (const [field, values] of Object.entries(expected)) {
    if (values === undefined || values === null) continue;
    const actual = (parsed as Record<string, unknown>)[field];
    if (!covered(values, actual)) {
      const wanted = Array.isArray(values) ? values.join(",") : String(values);
      const got = Array.isArray(actual) ? actual.join(",") : String(actual ?? "∅");
      out.push(`${field}=[${wanted}] (parsed: ${got})`);
    }
  }
  return out;
}

/** Why an ok:false run failed (the reason text + validation lane verdict). */
export function causeOfFailure(rec: OutfitRecommendation): EvalFailureMode | null {
  if (rec.ok) return null;
  if (rec.meta.retrievalDegraded) return "retrieval-degraded";
  const reason = rec.reason.toLowerCase();
  if (reason.includes("not enough")) return "not-enough-items";
  if (reason.includes("no wardrobe items matched") || reason.includes("no wardrobe items")) return "no-matches";
  if (rec.validation.semantic.run && rec.validation.semantic.passed === false) return "semantic-reject";
  return "validation-reject";
}

export function classifyFailure(rec: OutfitRecommendation, expectedOk: boolean): EvalFailureMode | null {
  if (rec.ok === expectedOk) return null;
  if (rec.ok) return "expected-fail-passed";
  return causeOfFailure(rec);
}

/** Turn one pipeline result into the per-case eval record. */
export function evaluateCase(def: EvalCase, rec: OutfitRecommendation, topK: number): EvalCaseResult {
  const ranked = (rec.retrieval?.hits ?? []).map((h) => h.itemId);
  const itemIds = rec.items.map((i) => i.id);
  const relevant = def.expected.relevantIds;
  const relevantSet = new Set(relevant);
  const nonEmptyRelevant = relevantSet.size > 0;

  const ghost = (ids: string[]) => ids.filter((id) => GHOST_RE.test(id));
  const ghostInHits = ghost(ranked).length > 0;
  // A leak is a ghost id REACHING THE USER (composed items). A ghost ranking in
  // retrieval hits is the expected precondition of the compose drop — it proves
  // the drop ran, it is not a leak.
  const staleLeak = ghost(itemIds).length > 0;

  // recall@k and compose recall (1.0 by convention when no relevance ground truth).
  const hitRecall = (k: number) => {
    if (!nonEmptyRelevant) return 1;
    const top = ranked.slice(0, k);
    return new Set(top.filter((id) => relevantSet.has(id))).size / relevantSet.size;
  };
  const recall = [5, topK].map((k) => ({ k, score: hitRecall(k) }));
  const composeRecall = nonEmptyRelevant
    ? new Set(itemIds.filter((id) => relevantSet.has(id))).size / relevantSet.size
    : 1;

  const parsedHard = rec.query.hard;
  const constraintMissing = missingConstraintValues(def.expected.hard, parsedHard);
  const hasExpectedHard = Object.values(def.expected.hard).some((v) => v !== undefined && (Array.isArray(v) ? v.length > 0 : v !== null));

  const hadHardRequest = Object.values(parsedHard).some((v) => v !== undefined && (Array.isArray(v) ? v.length > 0 : v !== null));
  const hardCheck = rec.validation.deterministic.checks.find((c) => c.id === "hard-constraint-satisfied");
  const constraintSatisfied =
    rec.items.length >= 2 && hadHardRequest ? (hardCheck?.passed ?? null) : null;

  const mustNotContainViolated = itemIds.filter((id) => (def.expected.mustNotContain ?? []).includes(id));
  const sem = rec.validation.semantic;
  // Token accounting must cover BOTH LLM calls in the pipeline: the
  // query-understanding call (meta.usage) and the advisory-validation call
  // (semantic.usage). Providers may omit `totalTokens` (the mock does), so fall
  // back to prompt + completion. Costs are only present when a price table is
  // configured (deepseek), and are summed when both calls report them.
  const usages = [rec.meta.usage, sem.usage].filter((u): u is NonNullable<typeof u> => u !== null && u !== undefined);
  const sum = (get: (u: NonNullable<typeof usages[number]>) => number | undefined) =>
    usages.reduce((acc, u) => acc + (get(u) ?? 0), 0);
  const usagePrompt = sum((u) => u.promptTokens);
  const usageCompletion = sum((u) => u.completionTokens);
  // Providers may omit `totalTokens` (the mock does); fall back to p+c.
  const usageTotal = sum((u) => u.totalTokens) || usagePrompt + usageCompletion;
  const costUsd = usages.map((u) => u.costUsd).filter((v): v is number => v !== undefined);
  const usageCostUsd = costUsd.length ? costUsd.reduce((a, b) => a + b, 0) : null;

  return {
    caseId: def.id,
    lang: def.lang,
    tags: def.tags,
    query: def.query,
    seedGhosts: def.seedGhosts ?? [],
    ok: rec.ok,
    expectedOk: def.expected.ok,
    reason: rec.reason,
    itemIds,
    itemCount: rec.items.length,
    grounded: rec.meta.grounded,
    parsedBy: rec.meta.parsedBy,
    parsedHard,
    constraintCoverage: hasExpectedHard
      ? 1 - constraintMissing.length / countExpectedValues(def.expected.hard)
      : 1,
    constraintMissing,
    constraintSatisfied,
    recall,
    composeRecall,
    candidateCount: rec.meta.candidateCount,
    indexedCount: rec.meta.indexedCount,
    retrievalDegraded: rec.meta.retrievalDegraded,
    validationPassed: rec.meta.validationPassed,
    validationDetPassed: rec.validation.deterministic.passed,
    detChecks: Object.fromEntries(rec.validation.deterministic.checks.map((c) => [c.id, c.passed])),
    semRun: sem.run,
    semPassed: sem.passed,
    semScore: sem.score,
    semValidationResult: sem.validationResult,
    staleLeak,
    mustNotContainViolated,
    ghostInHits,
    latencyMs: rec.meta.latencyMs,
    usagePrompt,
    usageCompletion,
    usageTotal,
    usageCostUsd,
    failureMode: classifyFailure(rec, def.expected.ok),
    cause: causeOfFailure(rec),
  };
}

function countExpectedValues(hard: NonNullable<EvalCase["expected"]>["hard"]): number {
  return Object.entries(hard).reduce(
    (n, [k, v]) => n + (Array.isArray(v) ? v.length : v === undefined ? 0 : 1),
    0,
  );
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: boolean[] | number[]) =>
  xs.length ? xs.filter(Boolean).length / xs.length : 0;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export function computeSummary(cases: EvalCaseResult[]): EvalSummary {
  const latency = cases.map((c) => c.latencyMs).sort((a, b) => a - b);
  const tokens = cases.map((c) => c.usageTotal);
  const costs = cases.map((c) => c.usageCostUsd).filter((v): v is number => v !== null);

  const metrics: MetricStat[] = [];

  // ── Deterministic (ground truth fixed by the golden set / catalog) ──
  const e2e = cases.map((c) => c.ok === c.expectedOk);
  metrics.push({ id: "e2e_success_rate", label: "End-to-end case success (rec.ok === expected.ok)", kind: "deterministic", value: pct(e2e), unit: "ratio" });
  const guards = cases.map(
    (c) => c.ok === c.expectedOk && !c.staleLeak && c.mustNotContainViolated.length === 0,
  );
  metrics.push({
    id: "golden_guard_success_rate",
    label: "Golden guard success (e2e AND no stale leak AND no mustNotContain violation)",
    kind: "deterministic",
    value: pct(guards),
    unit: "ratio",
  });

  const looks = cases.filter((c) => c.itemCount >= 2);
  const satisfied = looks.map((c) => c.constraintSatisfied);
  const hadHard = looks.filter((c) => c.constraintSatisfied !== null);
  metrics.push({
    id: "constraint_satisfaction_rate",
    label: "Hard-constraint satisfaction (composed looks with a hard request)",
    kind: "deterministic",
    value: hadHard.length ? pct(hadHard.map((c) => c.constraintSatisfied as boolean)) : 0,
    unit: "ratio",
  });

  metrics.push({
    id: "hard_parse_coverage",
    label: "Hard-constraint parse coverage (golden must-contain values present in parsed.hard)",
    kind: "llm-judged", // the PARSER feeds this; with the mock the union seed dominates
    value: mean(cases.map((c) => c.constraintCoverage)),
    unit: "ratio",
  });

  metrics.push({ id: "groundedness_rate", label: "Grounded look rate (≥2 real wardrobe pieces)", kind: "deterministic", value: pct(cases.map((c) => c.grounded)), unit: "ratio" });
  metrics.push({ id: "stale_leak_rate", label: "Stale-vector leak rate (ghost id reaching the composed look)", kind: "deterministic", value: pct(cases.map((c) => c.staleLeak)), unit: "ratio" });

  const withRelevant = cases.filter((c) => c.recall?.[0] !== undefined);
  const recall5 = withRelevant.map((c) => c.recall.find((r) => r.k === 5)?.score ?? 0);
  const recallTopK = withRelevant.map((c) => c.recall.find((r) => r.k === c.recall[c.recall.length - 1]?.k)?.score ?? 0);
  metrics.push({ id: "recall_at_5", label: "Recall@5 (ranked retrieval hits ∩ relevant)", kind: "deterministic", value: mean(recall5), unit: "ratio" });
  metrics.push({ id: "recall_at_12", label: "Recall@12 (pipeline topK)", kind: "deterministic", value: mean(recallTopK), unit: "ratio" });
  metrics.push({ id: "compose_recall", label: "Composed-look recall (recommended ids ∩ relevant / relevant)", kind: "deterministic", value: mean(cases.map((c) => c.composeRecall)), unit: "ratio" });

  metrics.push({
    id: "validation_pass_rate",
    label: "Validation pass rate (validation.passed among top composed looks)",
    kind: "deterministic",
    value: looks.length ? pct(looks.map((c) => c.validationPassed)) : 0,
    unit: "ratio",
  });
  metrics.push({
    id: "deterministic_guard_passes",
    label: "Deterministic guard rate (all 7 guards green among composed looks)",
    kind: "deterministic",
    value: looks.length ? pct(looks.map((c) => c.validationDetPassed)) : 0,
    unit: "ratio",
  });

  const weatherChecks = looks.filter((c) => c.detChecks["weather-suitability"] !== undefined);
  metrics.push({
    id: "weather_guard_fires",
    label: "Weather guard triggered (a piece failed season/weather for a composed look)",
    kind: "deterministic",
    value: weatherChecks.length ? pct(weatherChecks.map((c) => !c.detChecks["weather-suitability"])) : 0,
    unit: "ratio",
  });

  // ── LLM-judged (meaningful only with a hosted provider) ──
  const llmRuns = cases.filter((c) => c.parsedBy === "llm");
  metrics.push({ id: "llm_parse_rate", label: "LLM query-understanding runs (parsedBy === llm)", kind: "llm-judged", value: pct(cases.map((c) => c.parsedBy === "llm")), unit: "ratio" });
  const llmInvalid = cases.filter((c) => c.parsedBy === "llm" && c.constraintCoverage !== null && (c.constraintCoverage as number) < 1);
  metrics.push({ id: "llm_parse_coverage_gap", label: "LLM runs with a hard-coverage miss", kind: "llm-judged", value: llmInvalid.length, unit: "cases" });

  const semRuns = cases.filter((c) => c.semRun);
  metrics.push({ id: "semantic_run_rate", label: "Advisory semantic review runs", kind: "llm-judged", value: looks.length ? pct(looks.map((c) => c.semRun)) : 0, unit: "ratio" });
  metrics.push({ id: "semantic_pass_rate", label: "Semantic review pass rate (score ≥ 60)", kind: "llm-judged", value: semRuns.length ? pct(semRuns.map((c) => c.semPassed === true)) : 0, unit: "ratio" });
  metrics.push({ id: "semantic_mean_score", label: "Semantic review mean score", kind: "llm-judged", value: semRuns.length ? mean(semRuns.map((c) => c.semScore ?? 0)) : 0, unit: "0–100" });

  // ── Observability (latency / tokens / cost) ──
  metrics.push({ id: "latency_p50", label: "Latency median", kind: "observability", value: percentile(latency, 50), unit: "ms" });
  metrics.push({ id: "latency_p95", label: "Latency p95", kind: "observability", value: percentile(latency, 95), unit: "ms" });
  metrics.push({ id: "latency_mean", label: "Latency mean", kind: "observability", value: mean(latency), unit: "ms" });
  metrics.push({ id: "latency_max", label: "Latency max", kind: "observability", value: latency[latency.length - 1] ?? 0, unit: "ms" });
  metrics.push({ id: "tokens_total", label: "Total tokens used", kind: "observability", value: tokens.reduce((a, b) => a + b, 0), unit: "tokens" });
  metrics.push({ id: "tokens_mean", label: "Tokens per case (mean)", kind: "observability", value: mean(tokens), unit: "tokens" });
  if (costs.length) {
    metrics.push({ id: "cost_usd_total", label: "Total cost (when provider reports usage)", kind: "observability", value: costs.reduce((a, b) => a + b, 0), unit: "USD" });
    metrics.push({ id: "cost_usd_mean", label: "Cost per case (mean)", kind: "observability", value: mean(costs), unit: "USD" });
  }

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