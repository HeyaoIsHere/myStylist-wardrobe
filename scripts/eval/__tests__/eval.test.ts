import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goldenSchema, loadCatalog, loadGolden, validateGolden, catalogSchema } from "../golden";
import { classifyFailure, missingConstraintValues } from "../metrics";
import { runEvaluation } from "../runner";
import { LocalHashEmbedding } from "../../../src/lib/retrieval/embedding";
import { FlatFileVectorStore } from "../../../src/lib/retrieval/vectorstore";
import { reindexAll } from "../../../src/lib/retrieval/indexer";
import { semanticSearch } from "../../../src/lib/retrieval/search";
import { composeOutfit } from "../../../src/lib/recommend/compose";
import type { OutfitRecommendation } from "../../../src/lib/recommend/types";
import type { EvalCaseResult } from "../types";

/**
 * Phase 5 eval tests.
 *
 * The golden set itself is the point: these tests PIN the deterministic
 * pipeline behavior against the versioned goldens, so a change to the
 * extractor / mock / compose / validation vocabulary that shifts expected
 * behavior is caught here. Determism: two full runs must produce byte-equal
 * per-case results (latency and requestId excluded).
 */

function stripTiming(caseResult: EvalCaseResult) {
  const { latencyMs, ...rest } = caseResult;
  void latencyMs;
  return rest;
}

describe("eval dataset integrity", () => {
  it("loads and validates the versioned golden set", () => {
    const g = loadGolden("v1");
    assert.equal(g.schemaName, "mystylist-eval-golden");
    assert.equal(g.schemaVersion, "1");
    assert.equal(g.cases.length, 15);
    validateGolden(g, loadCatalog());
  });

  it("rejects golden drift (typo'd vocab value fails the zod schema)", () => {
    const g = loadGolden("v1");
    const broken = {
      schemaName: "mystylist-eval-golden",
      schemaVersion: "1",
      cases: [
        { ...g.cases[0], id: "drift-case", expected: { ...g.cases[0]!.expected, hard: { seasons: ["wintter"] } } },
      ],
    };
    const res = goldenSchema.safeParse(broken);
    assert.equal(res.success, false);
  });

  it("rejects catalog drift (bad category / weather value)", () => {
    const c = JSON.parse(readFileSync(join(process.cwd(), "scripts/eval/data/catalog.json"), "utf8"));
    const broken = { ...c, catalog: [{ ...c.catalog[0], item: { ...c.catalog[0].item, category: "capotes" }, attrs: { ...c.catalog[0].attrs } }] };
    assert.equal(catalogSchema.safeParse(broken).success, false);
    const brokenWeather = { ...c, catalog: [{ ...c.catalog[0], attrs: { ...c.catalog[0]!.attrs, weatherSuitability: ["arctic"] } }] };
    assert.equal(catalogSchema.safeParse(brokenWeather).success, false);
  });

  it("validateGolden rejects duplicate ids and unknown ghost sources", () => {
    const g = loadGolden("v1");
    const dup = { ...g, cases: [...g.cases, g.cases[1]!] };
    assert.throws(() => validateGolden(dup, loadCatalog()));
    const badGhost = { ...g, cases: [{ ...g.cases[0]!, id: "x", seedGhosts: ["t999"] }] };
    assert.throws(() => validateGolden(badGhost, loadCatalog()));
  });
});

describe("metric pure functions", () => {
  const dummyDef = loadGolden("v1").cases.find((c) => c.id === "hard-en-01")!;

  it("missingConstraintValues: missing values are reported field by field", () => {
    assert.deepEqual(missingConstraintValues({ categories: ["tops"] }, { categories: ["tops", "bottoms"] }), []);
    assert.ok(
      missingConstraintValues({ colors: ["blue", "black"] }, { colors: ["blue"] }).some((m) => m.startsWith("colors=")),
    );
    assert.deepEqual(missingConstraintValues({}, { colors: ["blue"] }), []);
  });

  it("classifyFailure distinguishes the three failure kinds", () => {
    const rec = (ok: boolean, reason: string, extra?: Partial<OutfitRecommendation>) =>
      ({
        ok,
        reason,
        meta: { retrievalDegraded: false },
        validation: { semantic: { run: true } },
        ...extra,
      }) as unknown as OutfitRecommendation;

    assert.equal(classifyFailure(rec(false, "No wardrobe items matched this request."), true), "no-matches");
    assert.equal(classifyFailure(rec(false, "Not enough matching pieces to compose a full look —"), true), "not-enough-items");
    assert.equal(
      classifyFailure(
        rec(false, "This look was rejected by validation: pieces suit...", {
          validation: { semantic: { run: false } },
        } as unknown as Partial<OutfitRecommendation>),
        true,
      ),
      "validation-reject",
    );
    assert.equal(classifyFailure(rec(true, "pairs..."), false), "expected-fail-passed");
    assert.equal(classifyFailure(rec(true, "pairs..."), true), null);
    void dummyDef;
  });
});

describe("ghost grounding — two layers", () => {
  it("layer 2: compose drops a ghost that search (constraints:null) did rank", async () => {
    const catalog = loadCatalog();
    const emb = new LocalHashEmbedding();
    const store = new FlatFileVectorStore(join(mkdtempSync(join(tmpdir(), "eval-ghost-")), "emb.json"));
    await reindexAll({ emb, store }, catalog.map((c) => ({ item: c.item, attrs: c.attrs })));
    const src = store.get("t1")!;
    store.upsert({ ...src, itemId: "ghost-t1" });

    const getItem = (id: string) => catalog.find((c) => c.item.id === id)?.item ?? null;
    const res = await semanticSearch(
      { emb, store, getItem, getAttrs: (id: string) => catalog.find((c) => c.item.id === id)?.attrs ?? null },
      { query: "something with a crew neck matching the vibe for the occasion", topK: 500, constraints: null },
    );
    // Layer-1 OFF: search with raw null constraints ranks the ghost.
    assert.ok(res.hits.some((h) => h.itemId === "ghost-t1"), "ghost-t1 should be ranked by search(constraints:null)");

    const composed = composeOutfit({
      query: { raw: "something with a crew neck", hard: {}, soft: [], context: {}, parsedBy: "deterministic" },
      hits: res.hits,
      getItem,
    });
    assert.ok(composed.ok, `look should complete, got: ${composed.reason}`);
    assert.ok(composed.items.length >= 2);
    assert.ok(!composed.items.some((i) => i.id.startsWith("ghost-")), "ghost must never survive compose");
    // layer-2 guarantee: every piece in the composed look resolves to a LIVE
    // catalog entry (the ghost — and only the ghost — was dropped).
    assert.ok(composed.items.every((i) => getItem(i.id) !== null), "every composed id must be live");
  });
});

describe("full eval runs", () => {
  it("is deterministic across two runs (timing excluded)", async () => {
    const outA = join(mkdtempSync(join(tmpdir(), "eval-det-a-")), "out");
    const outB = join(mkdtempSync(join(tmpdir(), "eval-det-b-")), "out");
    const [reportA, reportB] = await Promise.all([
      runEvaluation({ out: outA }),
      runEvaluation({ out: outB }),
    ]);

    // Per-case results — everything except latency — must be byte-equal.
    assert.deepEqual(
      reportA.cases.map(stripTiming),
      reportB.cases.map(stripTiming),
      "two runs must produce identical per-case results",
    );
    // Non-observability metrics must be byte-equal.
    const metrics = (r: typeof reportA) => r.summary.metrics.filter((m) => m.kind !== "observability").map((m) => [m.id, m.value]);
    assert.deepEqual(metrics(reportA), metrics(reportB));
  });

  it("satisfies the golden-set guarantees the pipeline CONTRACTS to", async () => {
    const report = await runEvaluation({ out: join(mkdtempSync(join(tmpdir(), "eval-guards-")), "out") });
    const metric = (id: string) => report.summary.metrics.find((m) => m.id === id)!.value;

    assert.equal(report.summary.totals.caseCount, 15);
    assert.equal(metric("e2e_success_rate"), 1, "every case matches its expected ok verdict");
    assert.equal(metric("golden_guard_success_rate"), 1);
    assert.equal(metric("constraint_satisfaction_rate"), 1, "composed looks satisfy every requested hard constraint");
    assert.equal(metric("hard_parse_coverage"), 1, "golden must-contain values are always parsed");
    assert.equal(metric("stale_leak_rate"), 0, "no ghost id ever reaches the composed look");

    const byId = new Map(report.cases.map((c) => [c.caseId, c]));

    // Zero-result cases: shaped ok:false with zero candidates, empty look.
    for (const id of ["zero-en-01", "zero-zh-01"]) {
      const c = byId.get(id)!;
      assert.equal(c.ok, false);
      assert.equal(c.candidateCount, 0);
      assert.equal(c.itemCount, 0);
      assert.ok(c.reason.includes("No wardrobe items matched"));
      assert.equal(c.cause, "no-matches");
    }

    // The weather-negative case: every piece satisfies the hard constraints,
    // yet the deterministic weather guard rejects the look — the two signals
    // are distinct, and metrics record both.
    const w = byId.get("weather-en-02")!;
    assert.equal(w.ok, false);
    assert.equal(w.expectedOk, false);
    assert.equal(w.constraintSatisfied, true, "hard constraints themselves held");
    assert.equal(w.validationPassed, false);
    assert.equal(w.detChecks["weather-suitability"], false);
    assert.equal(w.cause, "validation-reject");

    // Stale cases: grounded looks, ghosts nowhere.
    for (const id of ["stale-en-01", "stale-zh-01", "stale-en-02"]) {
      const c = byId.get(id)!;
      assert.equal(c.ok, true);
      assert.ok(!c.itemIds.some((i) => i.startsWith("ghost-")), `${id} leaked a ghost`);
    }

    // usage surfaced from both LLM calls (query understanding + semantic review).
    assert.ok(report.cases.every((c) => c.usageTotal > 0), "every mock run reports deterministic usage");
  });
});