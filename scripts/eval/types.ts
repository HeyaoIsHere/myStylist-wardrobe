import type { ClothingAttributes } from "../../src/lib/metadata/schema";
import type { Category } from "../../src/lib/types";
import type { MetadataConstraints } from "../../src/lib/retrieval/types";

/**
 * Phase 5 evaluation type surface — the versioned golden dataset + result
 * records. Pure data types with no runtime behavior; `golden.ts` loads and
 * validates files against the zod schemas, `runner.ts` produces results.
 */

// ── Synthetic catalog (never touches the user's data/) ───────────────────────

/** A catalog row as the eval knows it: the store item + its metadata record. */
export interface EvalCatalogItem {
  item: { id: string; name: string; category: Category };
  attrs: ClothingAttributes | null;
}

// ── Golden dataset ───────────────────────────────────────────────────────────

/** What the evaluator asserts about ONE case. */
export interface EvalExpectation {
  /**
   * Hard-constraint `must-contain` subsets — the parsed `query.hard` must
   * include AT LEAST these values (coverage, not equality). The deterministic
   * extractor + mock union may add more; equal parsers must never omit these.
   * Empty object = no hard expectations.
   */
  hard: MetadataConstraints;
  /** Expected final `ok` verdict. */
  ok: boolean;
  /** Item ids that are "relevant" for recall purposes (may be partial truth —
   *  ranking recall only needs the top hits to contain these). */
  relevantIds: string[];
  /** If present, the recommendations must NOT contain any of these ids. */
  mustNotContain?: string[];
}

export type EvalLang = "en" | "zh";

/** One golden scenario — versioned, lang-tagged, feature-tagged. */
export interface EvalCase {
  /** stable id within the version (e.g. "normal-en-01"). */
  id: string;
  lang: EvalLang;
  /** feature facets: normal | hard | zero | semantic | weather | stale */
  tags: string[];
  /** the free-text request fed to `recommend()` verbatim. */
  query: string;
  /** ids whose vector records are duplicated under a `ghost-<id>` itemId BEFORE
   *  the run, to exercise stale-vector grounding. */
  seedGhosts?: string[];
  /** notes for the human report (why this case exists, known quirks). */
  note?: string;
  expected: EvalExpectation;
}

export interface EvalGolden {
  schemaName: "mystylist-eval-golden";
  schemaVersion: "1";
  description?: string;
  cases: EvalCase[];
}

// ── Results ──────────────────────────────────────────────────────────────────

/** Success/failure classifier for one case (used by the report + failures list). */
export type EvalFailureMode =
  | "no-matches"
  | "not-enough-items"
  | "validation-reject"
  | "semantic-reject"
  | "expected-fail-passed"
  | "unexpected-fail"
  | "retrieval-degraded";

export interface EvalCaseResult {
  caseId: string;
  lang: EvalLang;
  tags: string[];
  query: string;
  seedGhosts: string[];
  ok: boolean;
  expectedOk: boolean;
  reason: string;
  itemIds: string[];
  itemCount: number;
  grounded: boolean;
  parsedBy: "llm" | "deterministic";
  parsedHard: MetadataConstraints;
  constraintCoverage: number;
  constraintMissing: string[];
  constraintSatisfied: boolean | null; // null when no hard constraint was requested
  recall: { k: number; score: number }[];
  composeRecall: number;
  candidateCount: number;
  indexedCount: number;
  retrievalDegraded: boolean;
  validationPassed: boolean;
  /** deterministic-lane verdict + per-guard outcomes (id → passed). */
  validationDetPassed: boolean;
  detChecks: Record<string, boolean>;
  semRun: boolean;
  semPassed: boolean | null;
  semScore: number | null;
  semValidationResult: "ok" | "coerced" | "invalid" | "none";
  staleLeak: boolean;
  /** ids from expected.mustNotContain that leaked into the composed look. */
  mustNotContainViolated: string[];
  /** informational: the ghost was actually ranked by retrieval (proves the compose drop ran). */
  ghostInHits: boolean;
  latencyMs: number;
  usagePrompt: number;
  usageCompletion: number;
  usageTotal: number;
  usageCostUsd: number | null;
  /** mismatch classifier — non-null ONLY when rec.ok !== expected.ok. */
  failureMode: EvalFailureMode | null;
  /** why an ok:false run failed (even when that failure was EXPECTED). */
  cause: EvalFailureMode | null;
}

/** per-metric kind — we VOW to separate deterministic vs LLM-judged. */
export type MetricKind = "deterministic" | "llm-judged" | "observability";

export interface MetricStat {
  id: string;
  label: string;
  kind: MetricKind;
  value: number;
  unit?: string;
}

export interface EvalSummary {
  totals: {
    caseCount: number;
    en: number;
    zh: number;
    byTag: Record<string, number>;
  };
  metrics: MetricStat[];
}

export interface EvalReport {
  schemaName: "mystylist-eval-report";
  schemaVersion: "1";
  golden: { id: string; schemaVersion: string; caseCount: number };
  config: { provider: string; embedding: string; embeddingModel: string; topK: number };
  run: { startedAt: string; finishedAt: string; durationMs: number; cwd: string };
  summary: EvalSummary;
  cases: EvalCaseResult[];
  failures: { caseId: string; query: string; mode: EvalFailureMode; reason: string }[];
}