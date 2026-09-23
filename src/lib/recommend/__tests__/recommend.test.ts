import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mockProvider } from "../../ai/providers/mock";
import { LocalHashEmbedding } from "../../retrieval/embedding";
import { FlatFileVectorStore } from "../../retrieval/vectorstore";
import { reindexAll, type IndexDeps } from "../../retrieval/indexer";
import { recommend } from "../pipeline";
import { OUTFIT_QUERY_SCHEMA_VERSION } from "../prompt";
import type { RecommendDeps } from "../types";
import type { ClothingAttributes } from "../../metadata/schema";

// Isolate all file I/O to a temp dir (each test gets its own vector store).
let tmp: string;
let fileCounter = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mystylist-recommend-test-"));
  process.env.MYSTYLIST_EMBEDDINGS_FILE = path.join(tmp, "embeddings.json");
  process.env.MYSTYLIST_LOG_DIR = path.join(tmp, "logs");
});

function attrs(partial: Partial<ClothingAttributes> = {}): ClothingAttributes {
  return {
    subcategory: null,
    colors: [],
    material: [],
    pattern: [],
    fit: null,
    styleTags: [],
    seasons: [],
    occasions: [],
    formality: null,
    weatherSuitability: [],
    ...partial,
  };
}

/** A small, realistic catalog with determinate palette names + seasons. */
const CATALOG = [
  { item: { id: "t1", name: "Blue Crew Neck Tee", category: "tops" as const }, attrs: attrs({ colors: [{ name: "blue" }], seasons: ["spring", "summer"], subcategory: "t-shirt" }) },
  { item: { id: "t2", name: "Black Turtleneck", category: "tops" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"], subcategory: "knit top" }) },
  { item: { id: "b1", name: "Beige Straight Trousers", category: "bottoms" as const }, attrs: attrs({ colors: [{ name: "beige" }], seasons: ["spring", "summer"], subcategory: "trousers" }) },
  { item: { id: "b2", name: "Black Slim Jeans", category: "bottoms" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"], subcategory: "jeans" }) },
  { item: { id: "d1", name: "Beige Wrap Dress", category: "dresses" as const }, attrs: attrs({ colors: [{ name: "beige" }], seasons: ["spring", "summer"], formality: "smart-casual" }) },
  { item: { id: "o1", name: "Black Wool Overcoat", category: "outerwear" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"], material: ["wool"] }) },
  { item: { id: "o2", name: "Grey Trench Coat", category: "outerwear" as const }, attrs: attrs({ colors: [{ name: "grey" }], seasons: ["spring"], material: ["polyester"] }) },
  { item: { id: "s1", name: "White Leather Sneakers", category: "shoes" as const }, attrs: attrs({ colors: [{ name: "white" }], seasons: ["spring", "summer"] }) },
  { item: { id: "s2", name: "Black Leather Boots", category: "shoes" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"] }) },
];
const ALL_IDS = new Set(CATALOG.map((c) => c.item.id));

const realIdsOf = (items: { id: string }[]) =>
  items.map((i) => i.id).every((id) => ALL_IDS.has(id)) && items.length > 0;

/** Index the catalog into a fresh isolated store and return wired deps. */
async function buildDeps(): Promise<RecommendDeps> {
  const store = new FlatFileVectorStore(path.join(tmp, `rec-emb-${fileCounter++}.json`));
  await reindexAll({ emb: new LocalHashEmbedding(), store } as IndexDeps, CATALOG);
  return {
    provider: mockProvider,
    emb: new LocalHashEmbedding(),
    store,
    getItem: (id) => {
      const row = CATALOG.find((c) => c.item.id === id);
      return row ? { id: row.item.id, name: row.item.name, category: row.item.category } : null;
    },
    getAttrs: (id) => CATALOG.find((c) => c.item.id === id)?.attrs ?? null,
    getCatalog: () => CATALOG.map((c) => c.item.id),
  };
}

// ── 1 · normal English query → grounded recommendation ───────────────────────

test("normal English request produces a grounded recommendation", async () => {
  const deps = await buildDeps();
  const rec = await recommend("I need a relaxed outfit for a date with a top and trousers", deps);
  assert.equal(rec.ok, true);
  assert.ok(rec.items.length >= 2, `expected ≥2 pieces, got ${rec.items.length}`);
  assert.equal(realIdsOf(rec.items), true, "every recommended id must be a real catalog id");
  assert.equal(rec.meta.grounded, true);
  assert.equal(rec.query.parsedBy, "llm", "mock returns a valid OutfitQuery so the LLM lane succeeds");
  assert.ok(rec.title.length > 0);
  assert.equal(rec.retrieval?.meta.degraded, false);
});

// ── 2 · Chinese query → bilingual extraction + grounding ─────────────────────

test("Chinese request extracts bilingual constraints and stays grounded", async () => {
  const deps = await buildDeps();
  const rec = await recommend("蓝色短袖配黑色裤子", deps);
  assert.equal(rec.ok, true);
  assert.equal(realIdsOf(rec.items), true);
  assert.ok(rec.query.hard.categories?.includes("tops"), "短袖 → tops");
  assert.ok(rec.query.hard.categories?.includes("bottoms"), "裤子 → bottoms");
  assert.ok(rec.query.hard.colors?.includes("blue"), "蓝色 → blue");
  assert.ok(rec.query.hard.colors?.includes("black"), "黑色 → black");
  // the search text carries the CJK tokens and the local hash embedding is CJK-safe
  assert.ok(rec.meta.candidateCount >= 2);
});

// ── 3 · hard constraints are enforced deterministically ──────────────────────

test("hard constraints (color + season) filter the recommendation deterministically", async () => {
  const deps = await buildDeps();
  const rec = await recommend("I want all-black pieces for winter", deps);
  assert.equal(rec.ok, true);
  assert.ok(rec.query.hard.colors?.includes("black"));
  assert.ok(rec.query.hard.seasons?.includes("winter"));
  const allowed = new Set(["t2", "b2", "o1", "s2"]);
  for (const item of rec.items) {
    assert.ok(allowed.has(item.id), `item ${item.id} must be black + winter`);
    assert.ok(rec.items.filter((i) => i.id === item.id).length <= 1, "no duplicate pieces");
  }
  assert.equal(rec.meta.candidateCount, 4, "exactly the black-winter capsule passes");
});

// ── 4 · soft preferences influence ranking only, never the filter ────────────

test("soft preferences ride the semantic query while hard constraints stay in the filter", async () => {
  const deps = await buildDeps();
  const rec = await recommend("minimalist black trousers and a white shirt please", deps);
  assert.equal(rec.ok, true);
  assert.ok(rec.query.hard.colors?.includes("black"));
  assert.ok(rec.query.hard.colors?.includes("white"));
  assert.ok(rec.query.hard.categories?.includes("tops"));
  assert.ok(rec.query.hard.categories?.includes("bottoms"));
  // soft came from the LLM lane (mock contributes descriptor phrases + the raw text)
  assert.ok(rec.query.soft.length >= 2, `expected several soft entries, got ${rec.query.soft.length}`);
  assert.ok(rec.query.soft.some((s) => s === "minimalist black trousers and a white shirt please" || s.includes("matching the vibe")));
  // the filter never contains occasion/mood/note — they are context only
  assert.equal(rec.meta.grounded, true);
});

// ── 5 · zero retrieval results → safe empty recommendation ───────────────────

test("zero-result retrieval returns a shaped, safe empty recommendation", async () => {
  const deps = await buildDeps();
  const rec = await recommend("an outfit with a beautiful handbag", deps);
  assert.equal(rec.ok, false);
  assert.deepEqual(rec.items, []);
  assert.equal(rec.meta.grounded, false);
  assert.equal(rec.meta.candidateCount, 0);
  assert.ok(rec.reason.length > 0, "reason explains why nothing matched");
  assert.equal(rec.meta.errorCategory, null, "empty results are a valid success state");

  // an entirely empty index also degrades safely
  const empty = { ...deps, store: new FlatFileVectorStore(path.join(tmp, "rec-empty.json")) };
  const rec2 = await recommend("a top", empty);
  assert.equal(rec2.ok, false);
  assert.deepEqual(rec2.items, []);
});

// ── 6 · malformed LLM output → deterministic fallback ────────────────────────

test("malformed LLM output falls back to the deterministic lane but stays grounded", async () => {
  const deps = await buildDeps();
  const rec = await recommend("@@qbad give me a black outfit with a top and trousers", deps);
  assert.equal(rec.query.parsedBy, "deterministic");
  assert.equal(rec.meta.validationResult, "invalid");
  assert.equal(rec.ok, true, "deterministic lane still yields a grounded look");
  assert.equal(realIdsOf(rec.items), true);
  assert.equal(rec.meta.grounded, true);
});

// ── 7 · stale vector for a nonexistent item is never recommended ─────────────

test("a stale vector (id no longer in the catalog) is never recommended", async () => {
  const deps = await buildDeps();
  // manually plant a ghost vector identical to t1's — it will rank at the top
  const t1rec = deps.store.get("t1")!;
  deps.store.upsert({ ...t1rec, itemId: "ghost", createdAt: t1rec.createdAt, updatedAt: t1rec.updatedAt });

  const rec = await recommend("crew neck", deps);
  for (const item of rec.items) {
    assert.notEqual(item.id, "ghost");
    assert.ok(ALL_IDS.has(item.id), `item ${item.id} must exist in the catalog`);
  }
  assert.equal(rec.items.some((i) => i.id === "t1"), true);
});

// ── 8 · LLM failure (both attempts) → deterministic lane + error telemetry ───

test("LLM failure degrades to the deterministic lane and records error/usage meta", async () => {
  const deps = await buildDeps();
  const rec = await recommend("@@throw black top and black trousers", deps);
  assert.equal(rec.query.parsedBy, "deterministic");
  assert.equal(rec.meta.validationResult, "none");
  assert.equal(rec.meta.errorCategory, "network");
  assert.equal(rec.meta.llmAttempts, 2);
  assert.equal(rec.meta.llmRetries, 1);
  assert.equal(rec.ok, true, "the deterministic lane produces the look despite LLM loss");
  assert.equal(realIdsOf(rec.items), true);
});

// ── 9 · successful grounded recommendation reports full observability ────────

test("successful grounded recommendation reports model, latency, validation, retrieval meta", async () => {
  const deps = await buildDeps();
  const rec = await recommend("black top and black trousers", deps);
  assert.equal(rec.ok, true);
  assert.equal(rec.meta.grounded, true);
  assert.equal(rec.query.parsedBy, "llm");
  assert.equal(rec.meta.validationResult, "ok");
  assert.equal(rec.meta.provider, "mock");
  assert.equal(rec.meta.model, "mock-outfit-query-v1");
  assert.equal(rec.meta.schemaVersion, OUTFIT_QUERY_SCHEMA_VERSION);
  assert.equal(rec.meta.candidateCount, 2, "only t2 + b2 match black/category constraints");
  assert.equal(rec.meta.indexedCount, 9);
  assert.equal(rec.meta.itemCount, 2);
  assert.equal(rec.meta.llmAttempts, 1);
  assert.equal(rec.meta.llmRetries, 0);
  assert.equal(typeof rec.meta.usage?.promptTokens, "number", "token usage surfaced when provider reports it");
  assert.equal(rec.meta.errorCategory, null);
  assert.ok(rec.meta.latencyMs >= 0);
  assert.ok(rec.title, "winter season absent → title uses occasion");
});