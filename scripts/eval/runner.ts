import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mockProvider } from "../../src/lib/ai/providers/mock";
import { createDeepSeekProvider } from "../../src/lib/ai/providers/deepseek";
import type { AIProvider } from "../../src/lib/ai/provider";
import { LocalHashEmbedding, OpenAICompatEmbedding } from "../../src/lib/retrieval/embedding";
import type { EmbeddingProvider } from "../../src/lib/retrieval/types";
import { FlatFileVectorStore } from "../../src/lib/retrieval/vectorstore";
import { reindexAll } from "../../src/lib/retrieval/indexer";
import { recommend } from "../../src/lib/recommend/pipeline";
import type { RecommendDeps } from "../../src/lib/recommend/types";
import { loadCatalog, loadGolden, validateGolden } from "./golden";
import { evaluateCase, computeSummary } from "./metrics";
import { collectFailures, writeReport } from "./report";
import type { EvalCaseResult, EvalReport, MetricStat } from "./types";

/**
 * Phase 5 evaluation runner.
 *
 *   node scripts/eval/runner.ts [--provider mock|deepseek] [--embedding local|openai]
 *                               [--out <dir>] [--limit N]
 *
 * Hermetic by construction:
 *   · A fresh temp dir holds the vector store (MYSTYLIST_EMBEDDINGS_FILE is NOT
 *     used — the store is constructed with an explicit file path) and the
 *     telemetry log dir (MYSTYLIST_LOG_DIR → outDir), so running the eval NEVER
 *     touches the user's real `data/store.json`, `data/metadata.json`,
 *     `data/embeddings.json`, or `data/logs/`.
 *   · Catalog + expectations are the versioned golden set in scripts/eval/data/.
 *   · Deterministic by default: mock provider + LocalHashEmbedding. Latency and
 *     requestId are the only non-deterministic fields and are excluded from any
 *     determinism comparison (tests assert this).
 *
 * Production behavior is never modified: this script only builds and runs the
 * existing `recommend()` pipeline with injected deps.
 */

const TOP_K = 12; // matches the pipeline's hard-coded retrieveForOutfit topK.

interface Flags {
  provider: "mock" | "deepseek";
  embedding: "local" | "openai";
  out: string;
  limit: number | null;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    provider: "mock",
    embedding: "local",
    out: join("scripts", "eval", "out"),
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") flags.provider = (argv[++i] ?? "mock") as Flags["provider"];
    else if (a === "--embedding") flags.embedding = (argv[++i] ?? "local") as Flags["embedding"];
    else if (a === "--out") flags.out = argv[++i] ?? flags.out;
    else if (a === "--limit") flags.limit = Number(argv[++i]) || null;
  }
  return flags;
}

function makeProvider(kind: Flags["provider"]): AIProvider {
  return kind === "deepseek" ? createDeepSeekProvider() : mockProvider;
}

function makeEmbedding(kind: Flags["embedding"]): EmbeddingProvider {
  if (kind === "openai") return new OpenAICompatEmbedding();
  return new LocalHashEmbedding();
}

/** Seed one ghost vector per requested id (a duplicate of the live vector,
 *  under a `ghost-<id>` itemId) to exercise stale-vector grounding. */
function seedGhosts(store: FlatFileVectorStore, catalog: ReturnType<typeof loadCatalog>, ids: string[]): number {
  const byId = new Map(catalog.map((c) => [c.item.id, c]));
  let seeded = 0;
  for (const id of ids) {
    const src = store.get(id);
    const item = byId.get(id);
    if (!src || !item) continue;
    store.upsert({
      ...src,
      itemId: `ghost-${id}`,
      createdAt: src.createdAt,
      updatedAt: src.updatedAt, // keep identical so reindex-prune semantics match
    });
    seeded += 1;
  }
  return seeded;
}

export interface RunEvalOptions {
  provider?: Flags["provider"];
  embedding?: Flags["embedding"];
  out?: string;
  limit?: number | null;
}

export async function runEvaluation(opts: RunEvalOptions = {}): Promise<EvalReport> {
  const flags = parseFlags([]);
  const provider = makeProvider(opts.provider ?? flags.provider);
  const emb = makeEmbedding(opts.embedding ?? flags.embedding);
  const outDir = resolve(opts.out ?? flags.out);
  const limit = opts.limit ?? flags.limit;

  const catalog = loadCatalog();
  const golden = loadGolden();
  validateGolden(golden, catalog);
  const cases = limit ? golden.cases.slice(0, limit) : golden.cases;

  // ── Hermetic env: temp for the vector store, outDir for telemetry logs. ──
  const sandbox = mkdtempSync(join(tmpdir(), "mystylist-eval-"));
  const store = new FlatFileVectorStore(join(sandbox, "embeddings.json"));
  process.env.MYSTYLIST_LOG_DIR = outDir;

  const reindex = await reindexAll(
    { emb, store },
    catalog.map((c) => ({ item: c.item, attrs: c.attrs })),
  );

  // Seed every ghost referenced by any case (union, once).
  const ghostIds = [...new Set(cases.flatMap((c) => c.seedGhosts ?? []))];
  const seededGhosts = seedGhosts(store, catalog, ghostIds);

  const deps: RecommendDeps = {
    provider,
    emb,
    store,
    getItem: (id) => catalog.find((c) => c.item.id === id)?.item ?? null,
    getAttrs: (id) => catalog.find((c) => c.item.id === id)?.attrs ?? null,
    getCatalog: () => catalog.map((c) => c.item.id),
  };

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const results: EvalCaseResult[] = [];
  for (const def of cases) {
    // Hand the exact deps to the pipeline; never touch production data.
    const rec = await recommend(def.query, deps);
    results.push(evaluateCase(def, rec, TOP_K));
  }
  const durationMs = Date.now() - startedMs;

  const summary = computeSummary(results);
  const failures = collectFailures(results);
  const report: EvalReport = {
    schemaName: "mystylist-eval-report",
    schemaVersion: "1",
    golden: { id: "golden-v1", schemaVersion: golden.schemaVersion, caseCount: golden.cases.length },
    config: { provider: provider.name, embedding: emb.name, embeddingModel: emb.model, topK: TOP_K },
    run: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      cwd: process.cwd(),
    },
    summary,
    cases: results,
    failures,
  };

  const written = writeReport(report, outDir);

  console.log(renderConsole(report, { reindex, seededGhosts, outDir, jsonPathWritten: written.json.length > 0 }));
  rmSync(sandbox, { recursive: true, force: true });
  return report;
}

function renderConsole(
  report: EvalReport,
  ctx: { reindex: Awaited<ReturnType<typeof reindexAll>>; seededGhosts: number; outDir: string; jsonPathWritten: boolean },
): string {
  const lines: string[] = [];
  const metric = (id: string): MetricStat | undefined => report.summary.metrics.find((m) => m.id === id);
  const line = (id: string) => {
    const m = metric(id);
    return m ? `  ${m.label}: ${m.value.toFixed(3)}${m.unit ? ` ${m.unit}` : ""}` : "";
  };

  lines.push(`# myStylist eval — ${report.config.provider} / ${report.config.embeddingModel}`);
  lines.push(`${report.summary.totals.caseCount} cases (${report.summary.totals.en} en / ${report.summary.totals.zh} zh) · one hermetic temp store + reindex ${ctx.reindex.indexedTotal} vectors (ghosts seeded: ${ctx.seededGhosts})`);
  lines.push("");
  lines.push("Deterministic:");
  for (const id of ["e2e_success_rate", "golden_guard_success_rate", "constraint_satisfaction_rate", "hard_parse_coverage", "groundedness_rate", "recall_at_5", "recall_at_12", "compose_recall", "validation_pass_rate", "weather_guard_fires", "stale_leak_rate"]) {
    const l = line(id);
    if (l) lines.push(l);
  }
  lines.push("LLM-judged:");
  for (const id of ["llm_parse_rate", "semantic_run_rate", "semantic_pass_rate", "semantic_mean_score"]) {
    const l = line(id);
    if (l) lines.push(l);
  }
  lines.push("Observability:");
  for (const id of ["latency_p50", "latency_p95", "tokens_total", "tokens_mean", "cost_usd_total"]) {
    const l = line(id);
    if (l) lines.push(l);
  }
  lines.push("");
  lines.push("Failures:");
  if (report.failures.length === 0) {
    lines.push("  none.");
  } else {
    for (const f of report.failures) lines.push(`  ${f.caseId}: ${f.mode} — ${f.reason}`);
  }
  lines.push("");
  lines.push(`Artifacts written to ${ctx.outDir}:`);
  lines.push("  · latest.json  (machine-readable, stable schema)");
  lines.push("  · latest.md    (human-readable report)");
  return lines.join("\n");
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const isCli = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/eval/runner.ts");
if (isCli) {
  const flags = parseFlags(process.argv.slice(2));
  runEvaluation({ provider: flags.provider, embedding: flags.embedding, out: flags.out, limit: flags.limit }).catch((err) => {
    console.error("eval runner failed:", err);
    process.exit(1);
  });
}