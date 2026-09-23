import type { AIErrorCategory } from "../ai/provider";
import type { Category } from "../types";
import type { Season } from "../metadata/vocab";

/**
 * Shared types for the semantic-retrieval foundation.
 *
 * Two seams (ADR D-17/D-18), both replaceable:
 *   · `EmbeddingProvider` — turns text into vectors (offline local hash by
 *     default; hosted OpenAI-compatible optional).
 *   · `VectorStore` — where vectors live (flat JSON file today; pgvector /
 *     Qdrant / embedded HNSW are future implementations behind the same
 *     interface).
 * Every vector records model / version / text so embeddings can be
 * regenerated deterministically later (re-index-all).
 */

// ── Embedding ───────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly name: string;
  /** The concrete model that produced the vectors (recorded per vector). */
  readonly model: string;
  /** Provider contract version for the embedding impl. */
  readonly version: string;
  /** Known dimensionality, or null until first observed (hosted providers). */
  readonly dimension: number | null;
  embed(texts: string[]): Promise<EmbeddingOutput>;
}

export interface EmbeddingOutput {
  /** One vector per input text, in order. Vectors are L2-normalized. */
  vectors: number[][];
  latencyMs: number;
}

// ── Vector store ────────────────────────────────────────────────────────────

/** One persisted (itemId → vector) record, with full regeneration metadata. */
export interface VectorRecord {
  itemId: string;
  /** The exact text representation that produced the vector. */
  text: string;
  /** TEXT_REP_VERSION at build time — bump invalidates old embeddings. */
  textVersion: string;
  /** embedding provider model (e.g. "local-hash-bow-v1"). */
  model: string;
  /** embedding provider contract version. */
  embeddingVersion: string;
  dimension: number;
  vector: number[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface IndexMeta {
  model: string;
  embeddingVersion: string;
  textVersion: string;
  dimension: number;
  count: number;
  updatedAt: string | null;
}

export interface ScoredHit {
  itemId: string;
  /** cosine similarity in [0,1] (vectors are normalized on both sides). */
  score: number;
  record: VectorRecord;
}

export interface VectorStore {
  readonly name: string;
  get(itemId: string): VectorRecord | null;
  /** Keyed by itemId — overwrite semantics, duplicates are impossible. */
  upsert(record: VectorRecord): void;
  remove(itemId: string): void;
  /** Remove every record whose id is not in the keep-set. Returns removed ids. */
  prune(keepItemIds: ReadonlySet<string>): string[];
  all(): VectorRecord[];
  count(): number;
  /** Aggregate index meta (null when empty). */
  meta(): IndexMeta | null;
  /** Cosine ranking, descending. Records with incompatible dims are skipped. */
  search(vector: number[], opts?: { topK?: number }): ScoredHit[];
}

// ── Constraints (deterministic hard lane, applied as a pre-filter) ───────────

export interface MetadataConstraints {
  categories?: Category[];
  /** palette names, normalized (must intersect item colors). */
  colors?: string[];
  materials?: string[];
  seasons?: Season[];
  occasions?: string[];
  formality?: string | null;
  /** never surface these items, regardless of score. */
  excludeIds?: string[];
}

// ── Semantic search ─────────────────────────────────────────────────────────

export interface SemanticSearchMeta {
  strategy: string; // "semantic"
  vectorStore: string;
  embeddingModel: string;
  embeddingVersion: string;
  textVersion: string;
  dimension: number;
  filters: Record<string, unknown>;
  topK: number;
  /** candidates ranked (after constraints filtering) that were considered. */
  candidateCount: number;
  /** total indexed items in the store. */
  indexedCount: number;
  latencyMs: number;
  degraded: boolean;
  modelMismatch: boolean;
  errorCategory: AIErrorCategory | null;
}

export interface SemanticSearchResult {
  /** itemIds in ranked order with cosine scores. */
  hits: ScoredHit[];
  meta: SemanticSearchMeta;
}