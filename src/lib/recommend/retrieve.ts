import { semanticSearch, type SearchDeps } from "../retrieval/search";
import type { EmbeddingProvider, SemanticSearchResult, VectorStore } from "../retrieval/types";
import type { ClothingAttributes } from "../metadata/schema";
import type { Category } from "../types";
import type { OutfitQuery } from "./types";

/**
 * Thin adapter over the EXISTING retrieval lane (Phase 2 semantic search).
 *
 * No retrieval logic is re-implemented here: hard constraints are handed to
 * `semanticSearch` as its deterministic pre-filter, soft preferences (plus the
 * raw request) are folded into the query text that gets embedded and ranked.
 * The seam stays intact — a future hybrid/fusion lane plugs in here, not in
 * compose or pipeline.
 */

export interface RetrieveDeps {
  emb: EmbeddingProvider;
  store: VectorStore;
  getItem: (id: string) => { id: string; name: string; category: Category } | null;
  getAttrs: (id: string) => ClothingAttributes | null;
}

/** The ranking-only text: raw + soft preferences, deduped. Never filters. */
export function joinQueryText(query: OutfitQuery): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [query.raw, ...query.soft]) {
    const t = p.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      parts.push(t);
    }
  }
  return parts.join(" ");
}

export async function retrieveForOutfit(query: OutfitQuery, deps: RetrieveDeps): Promise<SemanticSearchResult> {
  const searchDeps: SearchDeps = {
    emb: deps.emb,
    store: deps.store,
    getItem: (id) => {
      const item = deps.getItem(id);
      return item ? { id: item.id, category: item.category } : null;
    },
    getAttrs: deps.getAttrs,
  };
  // semanticSearch NEVER throws: it returns a shaped degraded result on failure.
  return semanticSearch(searchDeps, {
    query: joinQueryText(query),
    constraints: query.hard,
    topK: 12,
  });
}