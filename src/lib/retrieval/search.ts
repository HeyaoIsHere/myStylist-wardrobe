import { createHash } from "node:crypto";
import { AIProviderError } from "../ai/provider";
import { logRetrieval } from "../telemetry";
import type { ClothingAttributes } from "../metadata/schema";
import type { Category } from "../types";
import { buildQueryText } from "./textrep";
import { filterByConstraints } from "./constraints";
import type { EmbeddingProvider, MetadataConstraints, SemanticSearchMeta, SemanticSearchResult, VectorStore } from "./types";

/**
 * Semantic search (the phase's read path): embed the query → apply metadata
 * constraints as a hard pre-filter → cosine-rank → top-k → telemetry.
 *
 * FAIL-SAFE: embedding/provider/store trouble returns a shaped, degraded result
 * (`degraded:true`), never a throw to the route. A query is never an image and
 * never carries keys — only text is logged (as a hash).
 */

export interface SearchDeps {
  emb: EmbeddingProvider;
  store: VectorStore;
  /** item lookup used by the constraints pre-filter. */
  getItem: (id: string) => { id: string; category: Category } | null;
  getAttrs: (id: string) => ClothingAttributes | null;
}

export interface SearchOpts {
  query: string;
  constraints?: MetadataConstraints | null;
  topK?: number;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function semanticSearch(deps: SearchDeps, opts: SearchOpts): Promise<SemanticSearchResult> {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const topK = Math.max(1, Math.min(opts.topK ?? 10, 50));
  const queryText = buildQueryText(opts.query);
  const queryHash = sha256(queryText).slice(0, 16);
  const storeMeta = deps.store.meta();
  const meta: SemanticSearchMeta = {
    strategy: "semantic",
    vectorStore: deps.store.name,
    embeddingModel: deps.emb.model,
    embeddingVersion: deps.emb.version,
    textVersion: storeMeta?.textVersion ?? "-",
    dimension: storeMeta?.dimension ?? deps.emb.dimension ?? 0,
    filters: {},
    topK,
    candidateCount: 0,
    indexedCount: storeMeta?.count ?? deps.store.count(),
    latencyMs: 0,
    degraded: false,
    modelMismatch: Boolean(storeMeta) && storeMeta!.model !== deps.emb.model,
    errorCategory: null,
  };

  try {
    const { vectors } = await deps.emb.embed([queryText]);
    const q = vectors[0];
    if (!q) throw new AIProviderError("provider", "embedding returned no vector");

    const hits = deps.store.search(q, { topK: 500 });
    const itemIds = hits.map((h) => h.itemId);
    const { passed, filters } = filterByConstraints(itemIds, opts.constraints, deps);
    meta.filters = filters;
    meta.candidateCount = passed.length;

    // Re-rank the constrained subset in the original score order, then top-k.
    const order = new Map(itemIds.map((id, i) => [id, i] as const));
    const result = new Map(hits.map((h) => [h.itemId, h] as const));
    const selected = passed
      .map((id) => result.get(id))
      .filter((h): h is NonNullable<typeof h> => Boolean(h))
      .sort((a, b) => order.get(a.itemId)! - order.get(b.itemId)!)
      .slice(0, topK);

    meta.latencyMs = Date.now() - started;
    logRetrieval({
      kind: "retrieval_search",
      requestId,
      queryHash,
      method: "semantic",
      filters,
      topK,
      latencyMs: meta.latencyMs,
      candidateCount: meta.candidateCount,
      embeddingModel: deps.emb.model,
      embeddingVersion: deps.emb.version,
      vectorStore: deps.store.name,
      success: true,
      errorCategory: null,
    });
    return { hits: selected, meta };
  } catch (err) {
    const category = err instanceof AIProviderError ? err.category : "unknown";
    meta.degraded = true;
    meta.errorCategory = category;
    meta.latencyMs = Date.now() - started;
    logRetrieval({
      kind: "retrieval_search",
      requestId,
      queryHash,
      method: "semantic",
      filters: null,
      topK,
      latencyMs: meta.latencyMs,
      candidateCount: 0,
      embeddingModel: deps.emb.model,
      embeddingVersion: deps.emb.version,
      vectorStore: deps.store.name,
      success: false,
      errorCategory: category,
    });
    return { hits: [], meta };
  }
}