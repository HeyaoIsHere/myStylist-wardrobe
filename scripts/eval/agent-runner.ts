import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mockProvider } from "../../src/lib/ai/providers/mock";
import { createDeepSeekProvider } from "../../src/lib/ai/providers/deepseek";
import type { AIProvider } from "../../src/lib/ai/provider";
import { LocalHashEmbedding } from "../../src/lib/retrieval/embedding";
import { FlatFileVectorStore } from "../../src/lib/retrieval/vectorstore";
import { reindexAll } from "../../src/lib/retrieval/indexer";
import {
  runAgent,
  createLlmDecisionProvider,
  mockAgentDecisionProvider,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TIMEOUT_MS,
} from "../../src/lib/agent/index";
import { MockWeatherProvider } from "../../src/lib/agent/weather";
import { MockPreferencesProvider } from "../../src/lib/agent/prefs";
import type { AgentDeps, AgentDecisionProvider } from "../../src/lib/agent/types";
import {
  loadAgentGolden,
  loadCatalog,
  validateAgentGolden,
} from "./agent-golden";
import { evaluateAgentCase, computeAgentSummary } from "./agent-metrics";
import { collectAgentFailures, writeAgentReport } from "./agent-report";
import type { AgentEvalReport } from "./agent-types";

/**
 * Phase 6 agent evaluation runner.
 *
 *   node scripts/eval/agent-runner.ts [--provider mock|deepseek] [--out <dir>]
 *                                     [--limit N] [--strict]
 *
 * Hermetic by construction (same discipline as the Phase 5 eval):
 *   · A fresh temp dir holds the vector store; MYSTYLIST_LOG_DIR → outDir. The
 *     user's real data files are never touched.
 *   · Golden set = scripts/eval/data/agent-golden-v1.json over the shared catalog.
 *   · Deterministic by default: mock provider + mock decision policy + offline
 *     embedding — exact tool trajectories are reproducible offline.
 *   · --provider deepseek runs the LLM decision lane (createLlmDecisionProvider).
 *     With --strict, exact expectations are still enforced (use only if the
 *     hosted model is expected to match the documented branching); without it,
 *     the run only reports trajectory mismatches without failing the process.
 */

interface Flags {
  provider: "mock" | "deepseek";
  out: string;
  limit: number | null;
  strict: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    provider: "mock",
    out: join("scripts", "eval", "out"),
    limit: null,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") flags.provider = (argv[++i] ?? "mock") as Flags["provider"];
    else if (a === "--out") flags.out = argv[++i] ?? flags.out;
    else if (a === "--limit") flags.limit = Number(argv[++i]) || null;
    else if (a === "--strict") flags.strict = true;
  }
  return flags;
}

function makeProvider(kind: Flags["provider"]): AIProvider {
  return kind === "deepseek" ? createDeepSeekProvider() : mockProvider;
}

/** Seed one ghost vector per requested id under a `ghost-<id>` itemId. */
function seedGhosts(store: FlatFileVectorStore, catalog: ReturnType<typeof loadCatalog>, ids: string[]): number {
  const byId = new Map(catalog.map((c) => [c.item.id, c]));
  let seeded = 0;
  for (const id of ids) {
    const src = store.get(id);
    const row = byId.get(id);
    if (!src || !row) continue;
    store.upsert({ ...src, itemId: `ghost-${id}` });
    seeded += 1;
  }
  return seeded;
}

export interface RunAgentEvalOptions {
  provider?: Flags["provider"];
  out?: string;
  limit?: number | null;
  strict?: boolean;
}

export async function runAgentEvaluation(opts: RunAgentEvalOptions = {}): Promise<AgentEvalReport> {
  const provider = makeProvider(opts.provider ?? "mock");
  const outDir = resolve(opts.out ?? join("scripts", "eval", "out"));
  const limit = opts.limit ?? null;
  const strict = opts.strict ?? false;
  const emb = new LocalHashEmbedding();

  const catalog = loadCatalog();
  const golden = loadAgentGolden();
  validateAgentGolden(golden, catalog);
  const cases = limit ? golden.cases.slice(0, limit) : golden.cases;

  // ── Hermetic env ──
  const sandbox = mkdtempSync(join(tmpdir(), "mystylist-agent-eval-"));
  const store = new FlatFileVectorStore(join(sandbox, "embeddings.json"));
  process.env.MYSTYLIST_LOG_DIR = outDir;
  await reindexAll(
    { emb, store },
    catalog.map((c) => ({ item: c.item, attrs: c.attrs })),
  );

  const ghostIds = [...new Set(cases.flatMap((c) => c.seedGhosts ?? []))];
  const seededGhosts = seedGhosts(store, catalog, ghostIds);

  const decisionProvider: AgentDecisionProvider =
    provider.name === "mock" ? mockAgentDecisionProvider : createLlmDecisionProvider();

  const deps: AgentDeps = {
    provider,
    emb,
    store,
    getItem: (id) => catalog.find((c) => c.item.id === id)?.item ?? null,
    getAttrs: (id) => catalog.find((c) => c.item.id === id)?.attrs ?? null,
    getCatalog: () => catalog.map((c) => c.item.id),
    weather: new MockWeatherProvider({ temperatureC: 4 }), // a cool day
    preferences: new MockPreferencesProvider(),
    decide: decisionProvider,
  };

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const results = [];
  for (const def of cases) {
    const res = await runAgent(def.query, deps, { timeoutMs: DEFAULT_TIMEOUT_MS, maxIterations: DEFAULT_MAX_ITERATIONS });
    results.push(evaluateAgentCase(def, res));
  }
  const durationMs = Date.now() - startedMs;

  const summary = computeAgentSummary(results);
  const failures = collectAgentFailures(results);
  const report: AgentEvalReport = {
    schemaName: "mystylist-agent-eval-report",
    schemaVersion: "1",
    golden: { id: "agent-golden-v1", schemaVersion: golden.schemaVersion, caseCount: golden.cases.length },
    config: { provider: provider.name, decision: provider.name === "mock" ? "mock-policy" : "llm" },
    run: { startedAt, finishedAt: new Date().toISOString(), durationMs, cwd: process.cwd() },
    summary,
    cases: results,
    failures,
  };

  void writeAgentReport(report, outDir);
  console.log(renderAgentConsole(report, { seededGhosts, outDir, strict }));
  rmSync(sandbox, { recursive: true, force: true });

  // Strict mode: a trajectory / termination mismatch exits non-zero (for CI).
  if (strict && failures.length > 0) {
    console.error(`agent eval FAILED in strict mode: ${failures.length} case(s) mismatched.`);
    process.exitCode = 1;
  }
  return report;
}

function renderAgentConsole(
  report: AgentEvalReport,
  ctx: { seededGhosts: number; outDir: string; strict: boolean },
): string {
  const lines: string[] = [];
  const metric = (id: string) => report.summary.metrics.find((m) => m.id === id);
  const line = (id: string) => {
    const m = metric(id);
    return m ? `  ${m.label}: ${m.value.toFixed(3)}${m.unit ? ` ${m.unit}` : ""}` : "";
  };

  lines.push(`# myStylist agent eval — ${report.config.provider} / ${report.config.decision}`);
  lines.push(`${report.summary.totals.caseCount} cases (${report.summary.totals.en} en / ${report.summary.totals.zh} zh) · hermetic temp store (ghosts seeded: ${ctx.seededGhosts})`);
  lines.push("");
  lines.push("Exact (deterministic expectations):");
  for (const id of ["agent_case_success_rate", "trajectory_match_rate", "termination_match_rate", "ok_match_rate", "groundedness_rate", "stale_leak_rate", "hard_preservation_rate", "hard_coverage_rate", "avg_iterations", "avg_tool_calls"]) {
    const l = line(id);
    if (l) lines.push(l);
  }
  lines.push("LLM-judged:");
  const llmL = line("llm_decision_rate");
  if (llmL) lines.push(llmL);
  lines.push("Observability:");
  for (const id of ["latency_p50", "latency_p95", "latency_mean"]) {
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
  lines.push("Per-case:");
  for (const c of report.cases) {
    lines.push(`  ${c.caseId}: [${c.trajectory.join(" → ")}] term=${c.termination} items=${c.itemIds.join(",") || "∅"} ${c.failureMode ? `FAIL(${c.failureMode})` : "PASS"}`);
  }
  lines.push("");
  lines.push(`Artifacts written to ${ctx.outDir}: latest-agent.json · latest-agent.md`);
  if (ctx.strict) lines.push("Mode: STRICT (mismatches fail the process).");
  return lines.join("\n");
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const isCli = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/eval/agent-runner.ts");
if (isCli) {
  const flags = parseFlags(process.argv.slice(2));
  runAgentEvaluation({ provider: flags.provider, out: flags.out, limit: flags.limit, strict: flags.strict }).catch((err) => {
    console.error("agent eval runner failed:", err);
    process.exit(1);
  });
}