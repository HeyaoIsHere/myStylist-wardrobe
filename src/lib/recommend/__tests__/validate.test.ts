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
import { combineValidation, validateOutfitDeterministic } from "../validate";
import { skippedSemanticValidation } from "../semantic";
import { OUTFIT_VALIDATION_SCHEMA_VERSION } from "../prompt";
import type { RecommendDeps, OutfitItemView, DeterministicValidation, SemanticValidation } from "../types";
import type { ClothingAttributes } from "../../metadata/schema";
import type { MetadataConstraints } from "../../retrieval/types";

// Isolate all file I/O to a temp dir (own vector store per test).
let tmp: string;
let fileCounter = 0;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mystylist-validate-test-"));
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

/** Catalog with deliberate weather coverage so the weather guard is testable. */
const CATALOG = [
  { item: { id: "t1", name: "Blue Crew Neck Tee", category: "tops" as const }, attrs: attrs({ colors: [{ name: "blue" }], seasons: ["spring", "summer"], weatherSuitability: ["mild"] }) },
  { item: { id: "t2", name: "Black Turtleneck", category: "tops" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"], weatherSuitability: ["cold"] }) },
  { item: { id: "b1", name: "Beige Straight Trousers", category: "bottoms" as const }, attrs: attrs({ colors: [{ name: "beige" }], seasons: ["spring", "summer"], weatherSuitability: ["mild"] }) },
  { item: { id: "b2", name: "Black Slim Jeans", category: "bottoms" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"], weatherSuitability: ["cold"] }) },
  { item: { id: "d1", name: "Beige Wrap Dress", category: "dresses" as const }, attrs: attrs({ colors: [{ name: "beige" }], seasons: ["spring", "summer"], weatherSuitability: ["mild"] }) },
  { item: { id: "s2", name: "Black Leather Boots", category: "shoes" as const }, attrs: attrs({ colors: [{ name: "black" }], seasons: ["autumn", "winter"], weatherSuitability: ["cold"] }) },
];
const ALL_IDS = new Set(CATALOG.map((c) => c.item.id));

const REAL_ITEM_IDS = () => CATALOG.map((c) => c.item.id);

function view(id: string, category?: string, score = 0.5): OutfitItemView {
  const row = CATALOG.find((c) => c.item.id === id);
  const cat = (category ?? row?.item.category ?? "tops") as OutfitItemView["category"];
  return { id, name: row?.item.name ?? id, category: cat, role: "other", score };
}

function getItem(id: string) {
  const row = CATALOG.find((c) => c.item.id === id);
  return row ? { id: row.item.id, category: row.item.category } : null;
}
function getAttrs(id: string) {
  return CATALOG.find((c) => c.item.id === id)?.attrs ?? null;
}
function det(run: { requested: OutfitItemView[]; constraints?: MetadataConstraints; wardrobeIds?: Set<string> }): DeterministicValidation {
  return validateOutfitDeterministic({
    requested: run.requested,
    constraints: run.constraints ?? {},
    wardrobeIds: run.wardrobeIds ?? new Set(REAL_ITEM_IDS()),
    getItem,
    getAttrs,
  });
}

const semPass = (): SemanticValidation => ({
  run: true,
  passed: true,
  score: 90,
  validationResult: "ok",
  checks: [
    { id: "style-coherence", passed: true, note: "ok" },
    { id: "color-harmony", passed: true, note: "ok" },
    { id: "occasion-appropriateness", passed: true, note: "ok" },
    { id: "silhouette-compatibility", passed: true, note: "ok" },
  ],
  issues: [],
  provider: "mock",
  model: "mock-outfit-validation-v1",
  schemaVersion: OUTFIT_VALIDATION_SCHEMA_VERSION,
  llmAttempts: 1,
  llmRetries: 0,
  usage: null,
  errorCategory: null,
  skipReason: null,
});

function semFail(): SemanticValidation {
  return {
    ...semPass(),
    passed: false,
    score: 40,
    issues: ["colour clash"],
    checks: [{ id: "style-coherence", passed: false, note: "tone mismatch" }],
  };
}

// ── 1 · a fully valid outfit passes every deterministic guard ───────────────

test("valid outfit passes all seven deterministic checks", () => {
  const result = det({ requested: [view("t1"), view("b1")], constraints: { categories: ["tops", "bottoms"] } });
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 7, "all seven guards present");
  for (const c of result.checks) {
    assert.equal(c.passed, true, `${c.id} should pass: ${c.detail}`);
  }
});

// ── 2 · a nonexistent item is rejected ──────────────────────────────────────

test("nonexistent item fails item-exists / item-in-wardrobe / no-stale", () => {
  const result = det({ requested: [view("t1"), view("ghost", "tops")] });
  assert.equal(result.passed, false);
  const byId = (id: string) => result.checks.find((c) => c.id === id)!;
  assert.equal(byId("item-exists").passed, false);
  assert.equal(byId("item-in-wardrobe").passed, false);
  assert.equal(byId("no-stale-items").passed, false);
  assert.ok(byId("item-exists").detail.includes("ghost"));
});

// ── 3 · duplicate items are rejected ────────────────────────────────────────

test("duplicate item fails the no-duplicates guard", () => {
  const result = det({ requested: [view("t1"), view("t1")] });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((c) => c.id === "no-duplicates")!.passed, false);
});

// ── 4 · a hard-constraint violation is caught deterministically ─────────────

test("item violating a requested colour constraint is flagged", () => {
  const result = det({
    requested: [view("t1"), view("b2")],
    constraints: { colors: ["black"] }, // t1 is blue → violates
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((c) => c.id === "hard-constraint-satisfied")!.passed, false);
});

// ── 5 · deterministic weather constraints, when metadata allows ─────────────

test("weather constraint rejects pieces unsuited to the requested season", () => {
  // t1 (mild) is fine for spring; s2 (cold) is fine for winter
  const cold = det({ requested: [view("t2"), view("s2")], constraints: { seasons: ["winter"] } });
  assert.equal(cold.passed, true);
  assert.equal(cold.checks.find((c) => c.id === "weather-suitability")!.passed, true);

  // a hot-weather dress requested in the middle of a 'summer' ask that ALSO
  // includes the mild tee: mild ∉ {warm, hot} → violation
  const hotDress = { item: { id: "d2", name: "Linen Summer Dress", category: "dresses" as const }, attrs: attrs({ colors: [{ name: "white" }], seasons: ["summer"], weatherSuitability: ["hot"] }) };
  CATALOG.push(hotDress);
  const bad = det({ requested: [view("t1"), view("b2"), view("d2")], constraints: { seasons: ["summer"] } });
  assert.equal(bad.passed, false);
  const weatherCheck = bad.checks.find((c) => c.id === "weather-suitability")!;
  assert.equal(weatherCheck.passed, false);
  assert.ok(weatherCheck.detail.includes("b2"), "boots tagged cold are unsuited for summer");
  CATALOG.pop();

  // items WITHOUT weather metadata are never penalised (metadata doesn't allow)
  const noMeta = { item: { id: "x1", name: "Mystery Top", category: "tops" as const }, attrs: attrs({}) };
  CATALOG.push(noMeta);
  const lax = det({ requested: [view("t2", "tops"), view("x1")], constraints: { seasons: ["winter"] } });
  assert.equal(lax.checks.find((c) => c.id === "weather-suitability")!.passed, true);
  CATALOG.pop();
});

// ── 5b · required categories are enforced when applicable ───────────────────

test("required-categories guard fires only when a core was explicitly requested", () => {
  const missingBottom = det({
    requested: [view("t1")],
    constraints: { categories: ["tops", "bottoms"] },
  });
  assert.equal(missingBottom.checks.find((c) => c.id === "required-categories")!.passed, false);

  const missingDress = det({
    requested: [view("t1"), view("b1")],
    constraints: { categories: ["dresses"] },
  });
  assert.equal(missingDress.checks.find((c) => c.id === "required-categories")!.passed, false);

  const accentsOnly = det({
    requested: [view("s2", "shoes")],
    constraints: { categories: ["shoes"] },
  });
  assert.equal(accentsOnly.checks.find((c) => c.id === "required-categories")!.passed, true);
});

// ── 6 · deterministic failures always override LLM approval ─────────────────

test("a deterministic failure overrides a passing semantic verdict", () => {
  const detFailed = combineValidation(det({ requested: [view("ghost", "tops")] }), semPass());
  assert.equal(detFailed.passed, false);
});

test("a passing deterministic verdict combined with a failing semantic verdict fails", () => {
  const look = combineValidation(det({ requested: [view("t1"), view("b1")] }), semFail());
  assert.equal(look.passed, false);
});

test("an unavailable semantic lane leaves the deterministic verdict intact", () => {
  const noSem = combineValidation(det({ requested: [view("t1"), view("b1")] }), skippedSemanticValidation("simulated outage"));
  assert.equal(noSem.passed, true);
  assert.equal(noSem.semantic.passed, null);
});

// ── integration: index the catalog and run the real pipeline ────────────────

async function buildDeps(): Promise<RecommendDeps> {
  const store = new FlatFileVectorStore(path.join(tmp, `val-emb-${fileCounter++}.json`));
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
    getCatalog: () => REAL_ITEM_IDS(),
  };
}

// ── 7 · semantic style failure rejects the look (PASS → FAIL path) ──────────

test("semantic style failure fails the recommendation despite deterministic pass", async () => {
  const deps = await buildDeps();
  const rec = await recommend("@@vstyle an outfit with a top and trousers", deps);
  assert.equal(rec.validation.deterministic.passed, true);
  assert.equal(rec.validation.semantic.run, true);
  assert.equal(rec.validation.semantic.passed, false);
  assert.equal(rec.validation.semantic.score, 40);
  assert.equal(rec.validation.passed, false);
  assert.equal(rec.ok, false);
  assert.equal(rec.meta.validationPassed, false);
  assert.ok(rec.reason.includes("style review"), `reason should explain the rejection: ${rec.reason}`);
});

// ── 8 · malformed LLM output — semantic verdict unavailable, guards hold ─────

test("malformed semantic output is rejected safely; deterministic verdict stands", async () => {
  const deps = await buildDeps();
  const rec = await recommend("@@vbad give me an outfit with a top and trousers", deps);
  assert.equal(rec.validation.deterministic.passed, true);
  assert.equal(rec.validation.semantic.run, true);
  assert.equal(rec.validation.semantic.passed, null);
  assert.equal(rec.validation.semantic.validationResult, "invalid");
  assert.equal(rec.meta.semanticValidationResult, "invalid");
  assert.equal(rec.validation.passed, true, "no usable verdict does not fail a pass");
  assert.equal(rec.ok, true);
});

// ── 9 · LLM unavailable — deterministic validation still runs and wins ───────

test("LLM unavailable: semantic skipped with network error, deterministic still validates", async () => {
  const deps = await buildDeps();
  const rec = await recommend("@@throw black top and black trousers", deps);
  assert.equal(rec.query.parsedBy, "deterministic");
  assert.equal(rec.validation.deterministic.passed, true, "deterministic validation ran despite LLM loss");
  assert.equal(rec.validation.semantic.run, false);
  assert.equal(rec.validation.semantic.errorCategory, "network");
  assert.equal(rec.validation.semantic.llmAttempts, 2);
  assert.equal(rec.validation.semantic.llmRetries, 1);
  assert.equal(rec.validation.passed, true);
  assert.equal(rec.ok, true, "a grounded, hard-passing look survives an LLM outage");
  assert.ok(ALL_IDS.has(rec.items[0].id));
});

// ── 10 · successful grounded validation (end-to-end) ────────────────────────

test("successful grounded recommendation passes full validation with observability", async () => {
  const deps = await buildDeps();
  const rec = await recommend("black top and black trousers", deps);
  assert.equal(rec.ok, true);
  assert.equal(rec.validation.passed, true);
  assert.equal(rec.validation.deterministic.passed, true);
  for (const c of rec.validation.deterministic.checks) assert.equal(c.passed, true, `${c.id}`);
  assert.equal(rec.validation.semantic.run, true);
  assert.equal(rec.validation.semantic.passed, true);
  assert.equal(typeof rec.validation.semantic.score, "number");
  assert.equal(rec.validation.semantic.checks.length, 4);
  assert.equal(rec.validation.semantic.provider, "mock");
  assert.equal(rec.validation.semantic.model, "mock-outfit-validation-v1");
  assert.equal(rec.validation.semantic.schemaVersion, OUTFIT_VALIDATION_SCHEMA_VERSION);
  assert.equal(rec.validation.semantic.validationResult, "ok");
  assert.equal(rec.meta.semanticRun, true);
  assert.equal(rec.meta.semanticPassed, true);
  assert.equal(rec.meta.semanticScore, rec.validation.semantic.score);

  // a semantically-passing look is logged as success
  const logPath = path.join(tmp, "logs", "recommend.jsonl");
  const last = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").pop()!);
  assert.equal(last.kind, "recommendation");
  assert.equal(last.validationPassed, true);
  assert.equal(last.semanticPassed, true);
  assert.equal(typeof last.semanticScore, "number");
  assert.ok(!last.queryHash.includes("black"), "query text must be hashed, never raw");
});

// ── 11 · no look to validate (empty result) → vacuous validation ────────────

test("an empty recommendation is a valid empty state, not a validation failure", async () => {
  const deps = await buildDeps();
  const rec = await recommend("an outfit with a beautiful handbag", deps);
  assert.equal(rec.ok, false);
  assert.equal(rec.validation.deterministic.passed, true, "nothing to fail");
  assert.equal(rec.validation.semantic.run, false);
  assert.ok((rec.validation.semantic.skipReason ?? "").includes("no look"));
  assert.equal(rec.validation.passed, true, "the empty result itself is not invalid");
});