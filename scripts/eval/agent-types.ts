import type { ClothingAttributes } from "../../src/lib/metadata/schema";
import type { Category } from "../../src/lib/types";
import type { MetadataConstraints } from "../../src/lib/retrieval/types";
import type { AgentToolName, AgentTerminationReason } from "../../src/lib/agent/types";

/**
 * Phase 6 agent evaluation type surface — the versioned golden dataset + result
 * records for the BOUNDED AGENT lane (trajectory verification, not just final
 * answers). Extends the Phase 5 eval: same catalog + hermetic-temp-store
 * discipline, but each case additionally asserts the exact tool trajectory and
 * termination reason the agent must produce.
 */

// ── Synthetic catalog (reused verbatim from the Phase 5 eval) ────────────────

/** A catalog row as the agent eval knows it: the store item + its metadata record. */
export interface AgentEvalCatalogItem {
  item: { id: string; name: string; category: Category };
  attrs: ClothingAttributes | null;
}

// ── Golden dataset ───────────────────────────────────────────────────────────

/**
 * The tool trajectory the agent MUST take, as an exact ordered sequence.
 * `*` alternatives are not supported — the mock deterministic policy makes the
 * trajectory a fixed function of (request, catalog, weather, preferences), so
 * golden trajectories are exact. When the LLM decision layer is exercised
 * (--provider deepseek), the same case runs but the trajectory is scored
 * leniently (termination reason + grounding, not exact tools).
 */
export type AgentTrajectory = AgentToolName[];

/** Expected end state of one agent run. */
export interface AgentExpected {
  /** Must contain AT LEAST these hard-constraint values (coverage, not equality). */
  hard: MetadataConstraints;
  /** Exact tool trajectory expected (mock policy). */
  trajectory: AgentTrajectory;
  /** Exact termination reason expected. */
  termination: AgentTerminationReason | "any";
  /** Expected final `ok` verdict. */
  ok: boolean;
  /** Relevant ids for recall purposes. */
  relevantIds: string[];
  /** ids that must NOT appear in the final items. */
  mustNotContain?: string[];
  /** When true, every search_wardrobe must observe the SAME hard constraint set
   *  (the "hard constraints are never relaxed" invariant), asserted via the
   *  trace's searchConstraints payloads. */
  hardStableAcrossSearches?: boolean;
}

export type AgentEvalLang = "en" | "zh";

/** One golden agent scenario — versioned, lang-tagged, feature-tagged. */
export interface AgentEvalCase {
  /** stable id within the version (e.g. "agent-normal-01"). */
  id: string;
  lang: AgentEvalLang;
  /** feature facets: normal | weather | prefs | zero | unsatisfiable | stale */
  tags: string[];
  /** the free-text request fed to `runAgent()` verbatim. */
  query: string;
  /** ghost ids to seed (the runner prefixes ghost-) to exercise stale grounding. */
  seedGhosts?: string[];
  note?: string;
  expected: AgentExpected;
}

export interface AgentEvalGolden {
  schemaName: "mystylist-agent-eval-golden";
  schemaVersion: "1";
  description?: string;
  cases: AgentEvalCase[];
}

// ── Results ──────────────────────────────────────────────────────────────────

export type AgentEvalFailureMode =
  | "trajectory-mismatch"
  | "termination-mismatch"
  | "ok-mismatch"
  | "hard-preservation"
  | "grounding"
  | "stale-leak"
  | "must-not-contain"
  | "hard-coverage"
  | "run-error";

export interface AgentEvalCaseResult {
  caseId: string;
  lang: AgentEvalLang;
  tags: string[];
  query: string;
  seedGhosts: string[];
  ok: boolean;
  expectedOk: boolean;
  termination: AgentTerminationReason | null;
  expectedTermination: string;
  terminationMatch: boolean;
  trajectory: AgentToolName[];
  expectedTrajectory: AgentTrajectory;
  trajectoryMatch: boolean;
  iterationCount: number;
  toolCallCount: number;
  itemIds: string[];
  itemCount: number;
  grounded: boolean;
  parsedHard: MetadataConstraints;
  constraintCoverage: number;
  constraintMissing: string[];
  mustNotContainViolated: string[];
  unreliableIds: string[];
  hardStable: boolean;
  expectedHardStable: boolean;
  candidateCounts: number[];
  latencyMs: number;
  decisionProvider: string;
  failureMode: AgentEvalFailureMode | null;
  failureReasons: string[];
}

export type AgentMetricKind = "deterministic" | "llm-judged" | "observability";

export interface AgentMetricStat {
  id: string;
  label: string;
  kind: AgentMetricKind;
  value: number;
  unit?: string;
}

export interface AgentEvalSummary {
  totals: {
    caseCount: number;
    en: number;
    zh: number;
    byTag: Record<string, number>;
  };
  metrics: AgentMetricStat[];
}

export interface AgentEvalReport {
  schemaName: "mystylist-agent-eval-report";
  schemaVersion: "1";
  golden: { id: string; schemaVersion: string; caseCount: number };
  config: { provider: string; decision: string };
  run: { startedAt: string; finishedAt: string; durationMs: number; cwd: string };
  summary: AgentEvalSummary;
  cases: AgentEvalCaseResult[];
  failures: { caseId: string; query: string; mode: AgentEvalFailureMode; reason: string }[];
}