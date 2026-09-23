import fs from "node:fs";
import path from "node:path";
import type { AIErrorCategory, TokenUsage } from "./ai/provider";
import type { AgentTerminationReason } from "./agent/types";
import type { MetadataValidationResult } from "./metadata/schema";
import type { ParseOrigin, QueryValidationResult } from "./recommend/types";

/**
 * Thin JSONL observability (ADR D-10). Single log sink for AI pipeline steps.
 *
 * SANITIZATION POLICY: log records may only contain the typed fields below.
 * They MUST never include API keys, raw user images, or free-form user content.
 * If a future caller needs richer context, add a dedicated typed field AND make
 * sure it is redacted — never dump raw payloads.
 */

const LOG_DIR_ENV = "MYSTYLIST_LOG_DIR";

function logDir(): string {
  const fromEnv = process.env[LOG_DIR_ENV];
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), "data", "logs");
}

export interface MetadataExtractionLog {
  kind: "metadata_extraction";
  requestId: string;
  clothingId: string;
  provider: string;
  model: string;
  version: string;
  startTime: string; // ISO
  durationMs: number;
  success: boolean;
  validationResult: MetadataValidationResult;
  retryCount: number;
  errorCategory: AIErrorCategory | null;
}

/** One semantic-retrieval operation. `filters` is a small typed object — never free-form query text (only its hash). */
export interface RetrievalLog {
  kind: "retrieval_search";
  requestId: string;
  /** safe query identifier — sha256(query)[0:16]; never the raw query. */
  queryHash: string;
  method: string; // "semantic"
  filters: Record<string, unknown> | null;
  topK: number;
  latencyMs: number;
  candidateCount: number;
  embeddingModel: string;
  embeddingVersion: string;
  vectorStore: string;
  success: boolean;
  errorCategory: AIErrorCategory | null;
}

export type IndexingOp = "create" | "update" | "delete" | "reindex" | "skip";

/** One indexing operation (create/update/delete/reindex). Never carries content. */
export interface IndexingLog {
  kind: "indexing";
  clothingId: string;
  op: IndexingOp;
  embeddingModel: string;
  embeddingVersion: string;
  durationMs: number;
  success: boolean;
  errorCategory: AIErrorCategory | null;
}

function appendJsonLine(entry: Record<string, unknown>, file = "metadata.jsonl"): void {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, file), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Telemetry must never break the pipeline — swallow and move on.
  }
}

/** Log one metadata-extraction attempt. Never throws. */
export function logMetadataExtraction(entry: MetadataExtractionLog): void {
  appendJsonLine({ ...entry });
}

/** Log one retrieval operation. Never throws. */
export function logRetrieval(entry: RetrievalLog): void {
  appendJsonLine({ ...entry }, "retrieval.jsonl");
}

/** Log one indexing operation. Never throws. */
export function logIndexing(entry: IndexingLog): void {
  appendJsonLine({ ...entry }, "retrieval.jsonl");
}

/**
 * One recommendation-workflow run (Phase 3 + Phase 4). Sanitized: the raw
 * request is represented only by its hash — never bundled into the log — and
 * neither item ids nor names nor LLM output are recorded.
 */
export interface RecommendationLog {
  kind: "recommendation";
  requestId: string;
  /** sha256(raw)[0:16] — never the free-form request text. */
  queryHash: string;
  parsedBy: ParseOrigin;
  validationResult: QueryValidationResult;
  provider: string;
  model: string;
  schemaVersion: string;
  latencyMs: number;
  llmAttempts: number;
  llmRetries: number;
  usage: TokenUsage | null;
  grounded: boolean;
  itemCount: number;
  candidateCount: number;
  retrievalDegraded: boolean;
  success: boolean;
  errorCategory: AIErrorCategory | null;
  /** Phase 4 — outcome of the outfit-validation stage (verdict + semantic lane). */
  validationPassed: boolean;
  semanticRun: boolean;
  semanticPassed: boolean | null;
  /** 0–100, null when semantic did not run. */
  semanticScore: number | null;
  /** outcome of the semantic LLM output parse (ok|coerced|invalid|none). */
  semanticValidationResult: QueryValidationResult;
  validationErrorCategory: AIErrorCategory | null;
}

/** Log one recommendation run. Never throws. */
export function logRecommendation(entry: RecommendationLog): void {
  appendJsonLine({ ...entry }, "recommend.jsonl");
}

// ── Phase 6 — agent runs ──────────────────────────────────────────────────────
//
// SANITIZED: an agent_tool record carries the tool NAME + a coded summary
// (counts/verdicts) only — never item ids, never the query text (just its
// sha256 hash), never model output, never chain-of-thought. agent_run carries
// the trajectory as tool names only. The trace answers "why did the agent call
// this tool?" from observable structured state, and the run-level report keeps
// the observability contract from ADR D-10/D-22.

/** One executed tool call in a run. No ids, no free text, no model output. */
export interface AgentToolLog {
  kind: "agent_tool";
  agentRunId: string;
  /** sha256(raw request)[0:16]. */
  queryHash: string;
  iteration: number;
  toolName: string; // allowlisted tool or "decision-provider"
  toolInputSchemaVersion: string;
  toolSuccess: boolean;
  toolResultSummary: string; // coded summary (counts + verdicts), never content
  /** set on the terminal tool (usually finish). */
  agentTerminationReason: AgentTerminationReason | null;
}

/** One full agent run. Sanitized like RecommendationLog. */
export interface AgentRunLog {
  kind: "agent_run";
  agentRunId: string;
  requestId: string;
  queryHash: string;
  terminationReason: AgentTerminationReason;
  decisionProvider: string;
  provider: string;
  model: string;
  toolCalls: number;
  iterations: number;
  latencyMs: number;
  usage: TokenUsage | null;
  grounded: boolean;
  itemCount: number;
  ok: boolean;
  errorCategory: AIErrorCategory | null;
  /** tool names only — the observable trajectory. */
  trajectory: string[];
}

/** Log one agent tool call. Never throws. */
export function logAgentTool(entry: Omit<AgentToolLog, "kind">): void {
  appendJsonLine({ ...entry, kind: "agent_tool" }, "agent.jsonl");
}

/** Log one complete agent run. Never throws. */
export function logAgentRun(entry: Omit<AgentRunLog, "kind">): void {
  appendJsonLine({ ...entry, kind: "agent_run" }, "agent.jsonl");
}