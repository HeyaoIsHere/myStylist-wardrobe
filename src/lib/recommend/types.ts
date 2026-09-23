import type { AIErrorCategory, AIProvider, TokenUsage } from "../ai/provider";
import type { ClothingAttributes } from "../metadata/schema";
import type { SemanticSearchResult } from "../retrieval/types";
import type { MetadataConstraints } from "../retrieval/types";
import type { EmbeddingProvider, VectorStore } from "../retrieval/types";
import type { Category } from "../types";

/**
 * Phase 3 domain types: LLM query understanding + grounded recommendation.
 *
 * The three-way split (requirement 3) is enforced structurally:
 *   · `hard`      — deterministic constraints the retrieval lane MUST respect.
 *   · `soft`      — preferences that influence SEMANTIC RANKING only (they are
 *                  merged into the query text, never into the filter).
 *   · `context`   — information that explains/flavours the request (occasion,
 *                  mood, note) and is surfaced in the reason — never filters.
 *
 * Grounding rule (never invented IDs): the LLM schema contains no item-ID and
 * no clothing-name fields at all. Only the retrieval lane emits itemIds; the
 * compose phase consumes nothing but those ids.
 */

export type ParseOrigin = "llm" | "deterministic";

/** Mirrors MetadataValidationResult for the query-understanding step. */
export type QueryValidationResult = "ok" | "coerced" | "invalid" | "none";

export interface QueryContext {
  occasion?: string;
  mood?: string;
  note?: string;
}

/** The structured, validated understanding of one free-text request. */
export interface OutfitQuery {
  /** the raw user request — the ONLY free-form input in the system. */
  raw: string;
  /** hard constraints — enforced deterministically by the structured lane. */
  hard: MetadataConstraints;
  /** soft preferences — merged into the semantic query text (ranking weight). */
  soft: string[];
  /** contextual information — explains the ask, never filters. */
  context: QueryContext;
  /** where the structured understanding came from (for observability). */
  parsedBy: ParseOrigin;
}

/** What slot one recommended piece fills in the composed look. */
export type OutfitRole =
  | "dress"
  | "top"
  | "bottom"
  | "outerwear"
  | "shoes"
  | "bag"
  | "accessory"
  | "other";

/** One recommended wardrobe item, always a REAL retrieved id. */
export interface OutfitItemView {
  id: string;
  name: string;
  category: Category;
  role: OutfitRole;
  score: number;
}

/** Observability meta for one recommendation run (sanitized — no raw text/ids). */
export interface RecommendationMeta {
  requestId: string;
  parsedBy: ParseOrigin;
  validationResult: QueryValidationResult;
  provider: string;
  model: string;
  /** the schema/prompt version the query-understanding step contracted against. */
  schemaVersion: string;
  latencyMs: number;
  llmAttempts: number;
  llmRetries: number;
  usage: TokenUsage | null;
  retrievalDegraded: boolean;
  retrievalModel: string;
  candidateCount: number;
  indexedCount: number;
  itemCount: number;
  grounded: boolean;
  errorCategory: AIErrorCategory | null;
  /** Phase 4 — outcome of the outfit-validation stage. */
  validationPassed: boolean;
  semanticRun: boolean;
  semanticPassed: boolean | null;
  semanticScore: number | null;
  /** semantic LLM output validation result (ok|coerced|invalid|none). */
  semanticValidationResult: QueryValidationResult;
}

/** The full grounded result of a recommendation run. Never throws. */
export interface OutfitRecommendation {
  /** true when a real, grounded look was composed (≥ 2 pieces) AND passed validation. */
  ok: boolean;
  /** short human label, e.g. "Winter Everyday look". */
  title: string;
  /** why this pairing works / why nothing was returned / why validation rejected it. */
  reason: string;
  /** the recommended pieces (empty when !ok). */
  items: OutfitItemView[];
  /** the structured understanding that drove the run. */
  query: OutfitQuery;
  /** the full retrieval result (hits + observability meta). */
  retrieval: SemanticSearchResult | null;
  /** the validation stage verdict + per-check detail (Phase 4). */
  validation: OutfitValidation;
  meta: RecommendationMeta;
}

// ── Outfit validation (Phase 4) ─────────────────────────────────────────────

/** Each deterministic guard, checked by id so reasons/telemetry stay coded. */
export type ValidationCheckId =
  | "item-exists"
  | "item-in-wardrobe"
  | "no-duplicates"
  | "hard-constraint-satisfied"
  | "required-categories"
  | "no-stale-items"
  | "weather-suitability";

export interface ValidationCheck {
  id: ValidationCheckId;
  /** human label used in the rejection reason. */
  label: string;
  passed: boolean;
  /** short code-safe detail (ids, counts) — never free-form user text. */
  detail: string;
}

export interface DeterministicValidation {
  passed: boolean;
  checks: ValidationCheck[];
}

/** The four advisory dimensions the LLM reviews (D-02: aesthetic judgment). */
export type SemanticCheckId =
  | "style-coherence"
  | "color-harmony"
  | "occasion-appropriateness"
  | "silhouette-compatibility";

export interface SemanticValidationCheck {
  id: SemanticCheckId;
  passed: boolean;
  note: string;
}

/**
 * The semantic (LLM) validation lane — ADVISORY only. It can add failures but
 * can never approve a look the deterministic lane rejected (D-23).
 */
export interface SemanticValidation {
  /** true when a model call was attempted and produced a usable verdict. */
  run: boolean;
  /** the verdict (null when not run or the model output was unusable). */
  passed: boolean | null;
  /** 0–100 (null when not run); score ≥ 60 ⇒ later `passed`. */
  score: number | null;
  /** outcome of the model OUTPUT parse (ok|coerced|invalid|none). */
  validationResult: QueryValidationResult;
  checks: SemanticValidationCheck[];
  /** advisory notes surfaced in the reason when the recommendation fails. */
  issues: string[];
  provider: string | null;
  model: string | null;
  /** the validation prompt/schema version the call contracted against. */
  schemaVersion: string | null;
  llmAttempts: number;
  llmRetries: number;
  usage: TokenUsage | null;
  errorCategory: AIErrorCategory | null;
  /** set when the semantic lane was intentionally skipped (deterministic fail / no look). */
  skipReason: string | null;
}

/** The full validation stage result attached to every recommendation. */
export interface OutfitValidation {
  /** final: deterministic result, AND semantic when it ran. Hard guards always win. */
  passed: boolean;
  deterministic: DeterministicValidation;
  semantic: SemanticValidation;
}

/** Everything a recommendation run needs. All injectable for tests. */
export interface RecommendDeps {
  provider: AIProvider;
  emb: EmbeddingProvider;
  store: VectorStore;
  /** full item lookup — used by retrieval (category) AND compose (name). */
  getItem: (id: string) => { id: string; name: string; category: Category } | null;
  /** metadata lookup feeding the deterministic constraint filter. */
  getAttrs: (id: string) => ClothingAttributes | null;
  /** the active wardrobe ids — feeds the deterministic membership check (Phase 4). */
  getCatalog: () => string[];
}