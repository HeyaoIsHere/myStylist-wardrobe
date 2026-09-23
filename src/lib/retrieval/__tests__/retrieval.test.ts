import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AIProviderError } from "../../ai/provider";
import { LocalHashEmbedding, OpenAICompatEmbedding, LOCAL_EMBEDDING_DIM } from "../embedding";
import { FlatFileVectorStore } from "../vectorstore";
import { buildItemText } from "../textrep";
import { defaultIndexDeps, ensureIndexed, reindexAll, removeFromIndex, type IndexDeps } from "../indexer";
import { semanticSearch } from "../search";
import type { EmbeddingProvider, MetadataConstraints, VectorStore } from "../types";
import type { ClothingAttributes } from "../../metadata/schema";

// Isolate all file I/O to a temp dir.
let tmp: string;
let embeddingsFile: string;
let logDir: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mystylist-retrieval-test-"));
  embeddingsFile = path.join(tmp, "embeddings.json");
  logDir = path.join(tmp, "logs");
  process.env.MYSTYLIST_EMBEDDINGS_FILE = embeddingsFile;
  process.env.MYSTYLIST_LOG_DIR = logDir;
});

function deps(): IndexDeps {
  // One fresh store per call — tests must not share an on-disk index.
  return {
    emb: new LocalHashEmbedding(),
    store: new FlatFileVectorStore(path.join(tmp, `emb-${fileCounter++}.json`)),
  };
}
let fileCounter = 0;

/** Minimal valid attributes fixture. */
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

const CATALOG = [
  { item: { id: "a1", name: "Blue Crew Neck Tee", category: "tops" as const }, attrs: attrs({ colors: [{ name: "blue" }], seasons: ["summer"], subcategory: "t-shirt" }) },
  { item: { id: "a2", name: "Black Wool Overcoat", category: "outerwear" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["winter"], material: ["wool"] }) },
];

// ── A · embedding generation ────────────────────────────────────────────────

test("local embedding: deterministic, normalized, fixed dimension, CJK-safe", async () => {
  const emb = new LocalHashEmbedding();
  const o1 = await emb.embed(["blue tee", "蓝色衬衫"]);
  assert.equal(o1.vectors.length, 2);
  for (const v of o1.vectors) {
    assert.equal(v.length, LOCAL_EMBEDDING_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `vector should be unit length, got ${norm}`);
  }
  // deterministic: same input → identical vector
  const o2 = await emb.embed(["blue tee", "蓝色衬衫"]);
  assert.deepEqual(o1.vectors, o2.vectors);
  // distinct inputs differ
  const o3 = await emb.embed(["red dress"]);
  assert.notDeepEqual(o3.vectors[0], o1.vectors[0]);
  // empty text must not crash → zero vector
  const empty = await emb.embed([""]);
  assert.ok(empty.vectors[0].every((x) => x === 0));
});

test("openai-compatible embedding: stubbed fetch, happy path and failures", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const parsed = init ? (JSON.parse(init.body as string) as { input: string[] }) : { input: [] as string[] };
    calls.push({ url, body: parsed });
    // a text containing "boom" simulates a server-side error (e.g. 401)
    if (parsed.input.some((t) => t.includes("boom"))) {
      return { ok: false, status: 401, text: async () => "no key", json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: parsed.input.map((_, i) => ({ embedding: [i + 1, 0, 0] })),
      }),
    } as unknown as Response;
  }) as typeof fetch;

  const emb = new OpenAICompatEmbedding({
    baseUrl: "https://emb.test",
    apiKey: "sk-test",
    model: "test-emb-3",
    fetchImpl: fetchStub,
  });
  const out = await emb.embed(["a", "b"]);
  assert.equal(out.vectors.length, 2);
  assert.equal(emb.model, "test-emb-3");
  assert.equal(calls[0]?.url, "https://emb.test/embeddings");
  assert.deepEqual((calls[0]?.body as { input: string[] }).input, ["a", "b"]);

  // http error → categorized
  await assert.rejects(
    emb.embed(["boom"]),
    (e: AIProviderError) => e.category === "http" && e.status === 401,
  );
  // missing key → config error (before any network call)
  const noKey = new OpenAICompatEmbedding({ fetchImpl: fetchStub });
  await assert.rejects(noKey.embed(["x"]), (e: AIProviderError) => e.category === "config");
  // malformed response → provider error
  const malformedStub = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
  const bad = new OpenAICompatEmbedding({ apiKey: "k", fetchImpl: malformedStub });
  await assert.rejects(bad.embed(["x"]), (e: AIProviderError) => e.category === "provider");
});

// ── B · indexing a new clothing item ────────────────────────────────────────

test("indexing a new item stores exactly one vector", async () => {
  const d = deps();
  const r1 = await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, d);
  assert.equal(r1.status, "created");
  assert.equal(d.store.count(), 1);
  const rec = d.store.get("a1");
  assert.ok(rec);
  assert.equal(rec.dimension, LOCAL_EMBEDDING_DIM);
  assert.equal(rec.textVersion, "textrep-v1");
  assert.equal(rec.model, "local-hash-bow-v1");
  assert.ok(rec.text.includes("blue")); // name + attrs + bilingual tokens
  assert.ok(rec.text.includes("蓝色"));
});

// ── C · updating an existing item's embedding ───────────────────────────────

test("changing the item updates its vector (not a duplicate)", async () => {
  const d = deps();
  await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, d);
  const before = d.store.get("a1")!.vector;
  const renamed = { ...CATALOG[0]!.item, name: "Navy Sleeveless Tank" };
  const r2 = await ensureIndexed(renamed, CATALOG[0]!.attrs, d);
  assert.equal(r2.status, "updated");
  assert.equal(d.store.count(), 1, "update overwrites the same record");
  const after = d.store.get("a1")!.vector;
  assert.notDeepEqual(after, before, "representation changed ⇒ vector recomputed");
  assert.equal(d.store.get("a1")!.createdAt, d.store.get("a1")!.createdAt);
});

// ── D · re-indexing (idempotent full rebuild + prune) ──────────────────────

test("reindexAll is idempotent and prunes stale vectors", async () => {
  const d = deps();
  const report1 = await reindexAll(d, [...CATALOG]);
  assert.equal(report1.created, 2);
  assert.equal(d.store.count(), 2);

  // second pass: nothing changed → all skipped, no churn
  const report2 = await reindexAll(d, [...CATALOG]);
  assert.equal(report2.skipped, 2);
  assert.equal(report2.created, 0);
  assert.equal(report2.updated, 0);
  assert.equal(d.store.count(), 2);

  // item removed from catalog → reclaimed
  const report3 = await reindexAll(d, [CATALOG[0]!]);
  assert.equal(report3.pruned, 1);
  assert.equal(d.store.count(), 1);
});

// ── E · duplicate prevention ────────────────────────────────────────────────

test("two identical index calls never produce duplicate vectors", async () => {
  const storeFile = path.join(tmp, "dedupe.json");
  const d: IndexDeps = { emb: new LocalHashEmbedding(), store: new FlatFileVectorStore(storeFile) };
  const r1 = await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, d);
  const r2 = await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, d);
  assert.equal(r1.status, "created");
  assert.equal(r2.status, "skip", "identical text+version+model → logged skip");
  assert.equal(d.store.count(), 1);

  // on-disk file also has a single record for the item
  const shape = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  assert.equal(Object.keys(shape.records).length, 1);
});

// ── F · semantic search ─────────────────────────────────────────────────────

test("semantic search ranks the best match first and respects constraints", async () => {
  const d = deps();
  await reindexAll(d, CATALOG);
  const ctx = {
    emb: d.emb,
    store: d.store,
    getItem: (id: string) => {
      const c = CATALOG.find((x) => x.item.id === id);
      return c ? { id: c.item.id, category: c.item.category } : null;
    },
    getAttrs: (id: string) => CATALOG.find((x) => x.item.id === id)?.attrs ?? null,
  };

  const r1 = await semanticSearch(ctx, { query: "blue crew neck tee" });
  assert.equal(r1.meta.degraded, false);
  assert.ok(r1.hits.length >= 1);
  assert.equal(r1.hits[0]!.itemId, "a1", "exact-ish query should rank the blue tee first");
  assert.ok(r1.hits[0]!.score > 0);

  // hard constraint narrows the set: only black items allowed
  const constraints: MetadataConstraints = { colors: ["black"] };
  const r2 = await semanticSearch(ctx, { query: "blue tee", constraints });
  assert.equal(r2.meta.filters.colors === undefined ? "" : (r2.meta.filters.colors as string[]).join(","), "black");
  assert.deepEqual(r2.hits.map((h) => h.itemId), ["a2"], "constraint excludes non-black");
  assert.equal(r2.meta.candidateCount, 1);

  // category constraint
  const r3 = await semanticSearch(ctx, { query: "anything", constraints: { categories: ["tops"] } });
  assert.deepEqual(r3.hits.map((h) => h.itemId), ["a1"]);
});

// ── G · empty search results ────────────────────────────────────────────────

test("semantic search with no index or no matches returns empty, not an error", async () => {
  const d = deps(); // fresh empty store
  const ctx = { emb: d.emb, store: d.store, getItem: () => null, getAttrs: () => null };
  const r1 = await semanticSearch(ctx, { query: "anything" });
  assert.equal(r1.hits.length, 0);
  assert.equal(r1.meta.candidateCount, 0);
  assert.equal(r1.meta.degraded, false, "empty index is a valid success state");

  // constraint that excludes everything short-circuits to empty
  await reindexAll(d, CATALOG);
  const r2 = await semanticSearch(ctx, { query: "blue", constraints: { occasions: ["ball"] } });
  assert.equal(r2.hits.length, 0);
  assert.equal(r2.meta.candidateCount, 0);
  assert.equal(r2.meta.degraded, false);
});

// ── H · embedding failure ───────────────────────────────────────────────────

class FailingEmbed implements EmbeddingProvider {
  readonly name = "failing";
  readonly model = "fail-v1";
  readonly version = "embed-v1";
  readonly dimension: number | null = 384;
  async embed(): Promise<never> {
    throw new AIProviderError("timeout", "forced embedding failure");
  }
}

test("embedding failure is recorded, leaves prior vector, search degrades", async () => {
  const good = deps();
  await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, good);
  const vectorBefore = good.store.get("a1")!.vector;

  const bad: IndexDeps = { emb: new FailingEmbed(), store: good.store };
  const r = await ensureIndexed(CATALOG[1]!.item, CATALOG[1]!.attrs, bad);
  assert.equal(r.status, "error");
  assert.equal(r.errorCategory, "timeout");
  assert.equal(good.store.count(), 1, "failed re-index leaves the store unchanged");
  assert.deepEqual(good.store.get("a1")!.vector, vectorBefore);

  // search against a failing embedding provider → degraded empty, categorized
  const d = deps();
  await reindexAll(d, CATALOG);
  const ctx = {
    emb: new FailingEmbed(),
    store: d.store,
    getItem: (id: string) => (CATALOG.find((x) => x.item.id === id) ? { id, category: "tops" as const } : null),
    getAttrs: (id: string) => CATALOG.find((x) => x.item.id === id)?.attrs ?? null,
  };
  const s = await semanticSearch(ctx, { query: "blue" });
  assert.equal(s.hits.length, 0);
  assert.equal(s.meta.degraded, true);
  assert.equal(s.meta.errorCategory, "timeout");
});

// ── I · vector-store failure ────────────────────────────────────────────────

class FlakySaveStore extends FlatFileVectorStore {
  failSaves = false;
  override save(): void {
    if (this.failSaves) throw new Error("disk full");
    super.save();
  }
}

class BrokenSearchStore extends FlatFileVectorStore {
  override search(): never {
    throw new Error("index crashed");
  }
}

test("vector-store failure is contained (indexer + search both degrade)", async () => {
  const flaky = new FlakySaveStore(path.join(tmp, "flaky.json"));
  const d: IndexDeps = { emb: new LocalHashEmbedding(), store: flaky };
  flaky.failSaves = false;
  await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, d);
  assert.equal(flaky.count(), 1);

  flaky.failSaves = true;
  const r = await ensureIndexed(CATALOG[1]!.item, CATALOG[1]!.attrs, d);
  assert.equal(r.status, "error");
  assert.equal(flaky.count(), 1, "failed write does not corrupt the index");

  // search with a store whose read path crashes → degraded empty, never a throw
  const broken = new BrokenSearchStore(path.join(tmp, "broken.json"));
  await new LocalHashEmbedding().embed([" "]); // prime nothing; store is empty
  const ctx = {
    emb: new LocalHashEmbedding(),
    store: broken as unknown as VectorStore,
    getItem: () => null,
    getAttrs: () => null,
  };
  const s = await semanticSearch(ctx, { query: "anything" });
  assert.equal(s.hits.length, 0);
  assert.equal(s.meta.degraded, true);
});

// ── registry of lifecycle helpers ───────────────────────────────────────────

test("removeFromIndex deletes the vector and is repeatable (no throw)", async () => {
  const d = deps();
  await ensureIndexed(CATALOG[0]!.item, CATALOG[0]!.attrs, d);
  removeFromIndex("a1", d);
  assert.equal(d.store.count(), 0);
  removeFromIndex("a1", d); // already gone — no-op
  assert.equal(d.store.count(), 0);
});

// ── textrep extras ──────────────────────────────────────────────────────────

test("text representation is bilingual-expanded and stable", () => {
  const t = buildItemText(
    { id: "x", name: "Blue Linen Shirt", category: "tops" },
    attrs({ colors: [{ name: "blue" }], seasons: ["summer"], material: ["linen"], styleTags: ["minimalist"] }),
  );
  assert.ok(t.includes("blue"));
  assert.ok(t.includes("蓝色"));
  assert.ok(t.includes("夏季"));
  assert.ok(t.includes("亚麻")); // linen zh token
  assert.ok(t.includes("极简")); // minimalist zh token
  // degraded (null attrs) still gives name + category
  const degraded = buildItemText({ id: "x", name: "Mystery Item", category: "dresses" }, null);
  assert.equal(degraded, "mystery item dresses");
  assert.equal(defaultIndexDeps().emb.model, "local-hash-bow-v1", "default provider is the offline one");
});