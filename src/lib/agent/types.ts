import type { AIProvider, AIErrorCategory, TokenUsage } from "../ai/provider";
import type { ClothingAttributes } from "../metadata/schema";
import type { EmbeddingProvider, MetadataConstraints, VectorStore } from "../retrieval/types";
import type { Category } from "../types";
import type {
  DeterministicValidation,
  OutfitItemView,
  SemanticValidation,
} from "../recommend/types";

/**
 * Phase 6 — the bounded Outfit Planner Agent. Types only: the runtime lives in
 * runner.ts, the decision layer in decide.ts, the tools in tools.ts.
 *
 * The agent EXPLICITLY orchestrates existing capabilities through an allowlist
 * of typed tools; it never re-implements retrieval / compose / validation.
 *
 *   User request
 *     ↓
 *   Decision layer (policy or LLM)  ──{ action, arguments }──▶ allowlist/zod
 *     ↓                                                          validation
 *   Tool execution (existing seams)
 *     ↓
 *   updated structured state ──▶ next decision  …  bounded by max-iterations
 *   and a deadline. terminationReason is always set.
 *
 * Grounding invariants (enforced by the runner + tool handlers, never by the
 * decision layer):
 *   · every recommended id resolves to a LIVE catalog entry,
 *   · generate_outfit only ever selects ids that came from a previous tool
 *     result (the search_wardrobe candidate set),
 *   · deterministic validation is ALWAYS re-run on the final look by the runner
 *     and remains authoritative — the agent cannot bypass it,
 *   · hard constraints (state.hard) are frozen and union-merged only; no tool
 *     ever removes a value.
 */

// ── Tools ────────────────────────────────────────────────────────────────────

export const AGENT_TOOL_NAMES = [
  "search_wardrobe",
  "get_weather",
  "get_user_preferences",
  "generate_outfit",
  "validate_outfit",
  "finish",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Version of the tool schemas the agent contracts against (bump on semantic change). */
export const AGENT_TOOL_SCHEMA_VERSION = "agent-tools-v1";

export interface AgentSearchInput {
  /** free-text ranking query — defaults to the user's request + soft signals. */
  query?: string;
  /** structural constraints ADDED to the frozen hard set (never removed). */
  constraints?: MetadataConstraints;
}

export interface AgentGenerateInput {
  /** subset of candidate ids from a prior search_wardrobe result. Unknown ids
   *   are dropped (grounding); an empty selection defaults to all candidates. */
  itemIds?: string[];
}

export interface AgentValidateInput {
  /** absent/empty → validate the CURRENT generation. */
  itemIds?: string[];
  context?: { occasion?: string; mood?: string; note?: string };
}

export type AgentFinishStatus = "success" | "no-valid" | "unsatisfiable";

export interface AgentFinishInput {
  /** the final answer; omitted = reuse the last generated outfit. */
  itemIds?: string[];
  message?: string;
  status?: AgentFinishStatus;
}

/**
 * A decision the agent is allowed to execute. Produced by the decision layer,
 * validated against the allowlist + zod by the runner BEFORE execution.
 */
export type AgentDecision =
  | { action: "search_wardrobe"; arguments: AgentSearchInput }
  | { action: "get_weather"; arguments: { location?: string } }
  | { action: "get_user_preferences"; arguments: Record<string, never> }
  | { action: "generate_outfit"; arguments: AgentGenerateInput }
  | { action: "validate_outfit"; arguments: AgentValidateInput }
  | { action: "finish"; arguments: AgentFinishInput };

/** Untrusted decision shape (as produced by any decision provider). */
export interface RawAgentDecision {
  action: string;
  arguments?: unknown;
}

// ── External providers (weather / preferences) ───────────────────────────────

export interface WeatherReport {
  location: string;
  condition: string; // e.g. "clear" | "rain" | "overcast"
  temperatureC: number;
  humidityPct?: number;
  /** provenance — mock vs a real API. */
  source: string;
}

export interface WeatherProvider {
  readonly name: string;
  getWeather(location?: string): Promise<WeatherReport>;
}

export interface UserPreferences {
  /** grounded signals only (e.g. style tags aggregated from LIKED items).
   *   Never invented: an empty array when the app has no meaningful signal. */
  styleSignals: string[];
  source: string;
}

export interface PreferencesProvider {
  readonly name: string;
  getPreferences(): Promise<UserPreferences>;
}

// ── State ────────────────────────────────────────────────────────────────────

/** one candidate from the retrieval lane — id + ranking score (never a ghost). */
export interface AgentCandidate {
  itemId: string;
  score: number;
}

/** Outcome of one validate_outfit tool call (det + advisory semantic). */
export interface AgentValidationOutcome {
  itemIds: string[];
  passed: boolean;
  deterministic: DeterministicValidation;
  semantic: SemanticValidation;
  score: number | null;
}

/** One executed tool call in the sanitized trace. No ids, no free text. */
export interface AgentTraceRecord {
  iteration: number;
  tool: AgentToolName;
  success: boolean;
  /** short coded summary (counts + verdicts), never user content. */
  summary: string;
  candidateCount?: number | null;
  generatedCount?: number | null;
  /** the effective constraints used by a search (hard-preservation observable). */
  searchConstraints?: MetadataConstraints;
  validationDetPassed?: boolean | null;
  validationSemPassed?: boolean | null;
  validationScore?: number | null;
}

export type AgentTerminationReason =
  | "valid-outfit" // grounded outfit passed deterministic validation (authoritative)
  | "no-valid-outfit" // agent gave up after exhausted alternatives
  | "unsatisfiable" // a hard constraint makes the request unsatisfiable
  | "max-iterations" // iteration budget consumed
  | "timeout" // deadline reached
  | "tool-unavailable" // a required tool/provider failed non-recoverably
  | "invalid-tool-call"; // the decision could not be validated after retries

/** The full observable agent state for one run. Structured only. */
export interface AgentState {
  requestId: string;
  startedAt: number;
  userRequest: string;
  /** FROZEN hard constraints (union with tool additions, never relaxed). */
  hard: MetadataConstraints;
  /** soft signals that ride the semantic query text (request + prefs + weather). */
  soft: string[];
  weather: WeatherReport | null;
  preferences: UserPreferences | null;
  /** last search_wardrobe candidates (live, ranked, no ghosts). */
  candidates: AgentCandidate[] | null;
  /** snapshot of the last search's query + effective constraints. */
  lastSearch: {
    query: string;
    constraints: MetadataConstraints;
    candidateCount: number;
    degraded: boolean;
  } | null;
  generated: OutfitItemView[] | null;
  validation: AgentValidationOutcome | null;
  searchAttempts: number;
  trace: AgentTraceRecord[];
  /** 1-indexed completed iterations. */
  iteration: number;
  terminationReason: AgentTerminationReason | null;
}

// ── Decision layer ───────────────────────────────────────────────────────────

export interface AgentDecisionContext {
  provider: AIProvider;
  /** invoked by an LLM decision provider so the runner can aggregate token usage. */
  onUsage?: (usage: TokenUsage) => void;
  /** invoked with the actual model name behind the decision (for observability). */
  onModel?: (model: string) => void;
}

/** The seam the decision layer plugs into. Deterministic policy or a hosted LLM. */
export type AgentDecisionProvider =
  (state: AgentState, ctx: AgentDecisionContext) => Promise<RawAgentDecision>;

// ── Deps / config / result ───────────────────────────────────────────────────

export interface AgentDeps {
  provider: AIProvider;
  emb: EmbeddingProvider;
  store: VectorStore;
  getItem: (id: string) => { id: string; name: string; category: Category } | null;
  getAttrs: (id: string) => ClothingAttributes | null;
  getCatalog: () => string[];
  weather: WeatherProvider;
  preferences: PreferencesProvider;
  decide: AgentDecisionProvider;
  /** injectable clock for deterministic timeout tests. */
  now?: () => number;
}

export interface AgentRunConfig {
  /** conservative loop bound (default 8). */
  maxIterations?: number;
  /** wall-clock deadline for the whole run (default 30s; 0 disables). */
  timeoutMs?: number;
  toolSchemaVersion?: string;
}

export interface AgentResult {
  ok: boolean;
  title: string;
  reason: string;
  items: OutfitItemView[];
  /** the frozen hard constraints the agent honored the whole run. */
  hard: MetadataConstraints;
  terminationReason: AgentTerminationReason;
  trace: AgentTraceRecord[];
  iterationCount: number;
  toolCallCount: number;
  durationMs: number;
  /** Name of the decision layer ('mock-policy' or the provider name). */
  decisionProvider: string;
  kind: "agent";
  validation: AgentValidationOutcome | null;
  meta: {
    agentRunId: string;
    requestId: string;
    provider: string;
    model: string;
    toolSchemaVersion: string;
    latencyMs: number;
    usage: TokenUsage | null;
    errorCategory: AIErrorCategory | null;
  };
}

export { OutfitItemView };