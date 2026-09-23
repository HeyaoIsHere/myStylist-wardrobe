import { NextResponse } from "next/server";
import { getStore } from "@/lib/db/store";
import { listMetadata } from "@/lib/metadata/store";
import { getEmbeddingProvider } from "@/lib/retrieval/embedding";
import { FlatFileVectorStore } from "@/lib/retrieval/vectorstore";
import { reindexAll, type IndexDeps } from "@/lib/retrieval/indexer";
import type { ClothingAttributes } from "@/lib/metadata/schema";

/**
 * POST /api/retrieval/reindex — idempotent full index rebuild (Phase 2).
 *
 * Rebuilds the embedding index from the CURRENT catalog (store.json) joined
 * with AI metadata (metadata.json), then prunes vectors for items that no
 * longer exist. Run it after upgrading the embedding model or the text
 * representation (version bump ⇒ deterministic regeneration).
 */
export const dynamic = "force-dynamic";

function buildDeps(): IndexDeps {
  return { emb: getEmbeddingProvider(), store: new FlatFileVectorStore() };
}

export async function POST() {
  const store = getStore();
  const records = listMetadata();
  const recordById = new Map(records.map((r) => [r.itemId, r] as const));

  const catalog = store.wardrobe.map((item) => ({
    item: { id: item.id, name: item.name, category: item.category },
    attrs: (recordById.get(item.id)?.aiGenerated ?? null) as ClothingAttributes | null,
  }));

  const report = await reindexAll(buildDeps(), catalog);
  return NextResponse.json({ ok: true, report });
}