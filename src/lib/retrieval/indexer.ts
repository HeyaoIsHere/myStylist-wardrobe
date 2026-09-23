import { AIProviderError } from "../ai/provider";
import { logIndexing } from "../telemetry";
import type { ClothingAttributes } from "../metadata/schema";
import { getEmbeddingProvider } from "./embedding";
import { FlatFileVectorStore } from "./vectorstore";
import { buildItemText, TEXT_REP_VERSION, type ItemLike } from "./textrep";
import type { EmbeddingProvider, VectorRecord, VectorStore } from "./types";

/**
 * Idempotent indexing (ADR D-17/D-18): maintains the vector store for the
 * wardrobe. Portions of both the embedding and the vector-store seams are the
 * only touch points; everything here is FAIL-SAFE — no embedding/store failure
 * can throw into the extract/save/delete flows.
 *
 * Guarantees:
 *   · `upsert` is keyed by itemId ⇒ duplicate vectors are impossible.
 *   · Second run with identical (text, textVersion, model, embeddingVersion)
 *     is a logged `skip` — no churn.
 *   · `reindexAll` rebuilds from the current catalog + metadata deterministically
 *     and PRUNES vectors for items that no longer exist (full-sync semantics).
 *   · On embedding/store failure the PRIOR vector is left in place.
 */

export interface IndexDeps {
  emb: EmbeddingProvider;
  store: VectorStore;
}

/** Default deps for production wiring (env-selected provider + flat-file store). */
export function defaultIndexDeps(): IndexDeps {
  return { emb: getEmbeddingProvider(), store: new FlatFileVectorStore() };
}

export type IndexStatus = "created" | "updated" | "skip" | "error";

export interface EnsureIndexedResult {
  status: IndexStatus;
  errorCategory: string | null;
}

export interface ReindexReport {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  pruned: number;
  indexedTotal: number;
  durationMs: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** One item's index record, embedding resolved. */
export async function ensureIndexed(
  item: ItemLike,
  attrs: ClothingAttributes | null,
  deps: IndexDeps,
): Promise<EnsureIndexedResult> {
  const started = Date.now();
  const text = buildItemText(item, attrs);
  const existing = deps.store.get(item.id);
  const unchanged =
    existing !== null &&
    existing.text === text &&
    existing.textVersion === TEXT_REP_VERSION &&
    existing.model === deps.emb.model &&
    existing.embeddingVersion === deps.emb.version;

  if (unchanged) {
    logIndexing({
      kind: "indexing",
      clothingId: item.id,
      op: "skip",
      embeddingModel: deps.emb.model,
      embeddingVersion: deps.emb.version,
      durationMs: Date.now() - started,
      success: true,
      errorCategory: null,
    });
    return { status: "skip", errorCategory: null };
  }

  try {
    const { vectors } = await deps.emb.embed([text]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) throw new AIProviderError("provider", "embedding returned an empty vector");
    const now = nowIso();
    const record: VectorRecord = {
      itemId: item.id,
      text,
      textVersion: TEXT_REP_VERSION,
      model: deps.emb.model,
      embeddingVersion: deps.emb.version,
      dimension: vector.length,
      vector,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    deps.store.upsert(record);
    const status: IndexStatus = existing ? "updated" : "created";
    logIndexing({
      kind: "indexing",
      clothingId: item.id,
      op: status === "created" ? "create" : "update",
      embeddingModel: deps.emb.model,
      embeddingVersion: deps.emb.version,
      durationMs: Date.now() - started,
      success: true,
      errorCategory: null,
    });
    return { status, errorCategory: null };
  } catch (err) {
    const category = err instanceof AIProviderError ? err.category : "unknown";
    logIndexing({
      kind: "indexing",
      clothingId: item.id,
      op: existing ? "update" : "create",
      embeddingModel: deps.emb.model,
      embeddingVersion: deps.emb.version,
      durationMs: Date.now() - started,
      success: false,
      errorCategory: category,
    });
    return { status: "error", errorCategory: category };
  }
}

export function removeFromIndex(itemId: string, deps: IndexDeps): void {
  const started = Date.now();
  deps.store.remove(itemId);
  logIndexing({
    kind: "indexing",
    clothingId: itemId,
    op: "delete",
    embeddingModel: deps.emb.model,
    embeddingVersion: deps.emb.version,
    durationMs: Date.now() - started,
    success: true,
    errorCategory: null,
  });
}

/**
 * Rebuild the index from the current catalog (idempotent): index every item in
 * order, then prune vectors for items that no longer exist.
 */
export async function reindexAll(
  deps: IndexDeps,
  catalog: { item: ItemLike; attrs: ClothingAttributes | null }[],
): Promise<ReindexReport> {
  const started = Date.now();
  const report: ReindexReport = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    pruned: 0,
    indexedTotal: 0,
    durationMs: 0,
  };
  const keep = new Set<string>();
  for (const { item, attrs } of catalog) {
    keep.add(item.id);
    const res = await ensureIndexed(item, attrs, deps);
    if (res.status === "created") report.created += 1;
    else if (res.status === "updated") report.updated += 1;
    else if (res.status === "skip") report.skipped += 1;
    else report.errors += 1;
  }
  report.pruned = deps.store.prune(keep).length;
  report.indexedTotal = deps.store.count();
  report.durationMs = Date.now() - started;
  return report;
}