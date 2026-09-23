import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mockProvider } from "../../ai/providers/mock";
import { LocalHashEmbedding } from "../../retrieval/embedding";
import { FlatFileVectorStore } from "../../retrieval/vectorstore";
import { reindexAll, type IndexDeps } from "../../retrieval/indexer";
import { validateOutfitDeterministic } from "../../recommend/validate";
import { matchesConstraints } from "../../retrieval/constraints";
import { loadCatalog } from "../../../../scripts/eval/golden";
import type { EvalCatalogItem } from "../../../../scripts/eval/types";
import {
  agentDecisionRawSchema,
  parseAgentDecision,
} from "../schema";
import { mockAgentDecisionProvider } from "../decide";
import { runAgent } from "../runner";
import { MockWeatherProvider } from "../weather";
import { MockPreferencesProvider } from "../prefs";
import { mergeConstraints } from "../state";
import { AGENT_TOOL_SCHEMA_VERSION } from "../types";
import type { AgentDeps } from "../types";

/**
 * Phase 6 agent tests.
 *
 * The runner, the six tool handlers, the zod allowlist, the deterministic
 * decision policy and the bounded loop are all exercised against the SAME
 * eval catalog (18 items, no bags, one weather-mismatched shoe s3) so the
 * golden trajectories below stay deterministic and reproducible offline.
 */

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mystylist-agent-test-"));
  process.env.MYSTYLIST_LOG_DIR = path.join(tmp, "logs");
});

const CATALOG = loadCatalog();
const ALL_IDS = new Set(CATALOG.map((c) => c.item.id));

async function depsFor(over: Partial<AgentDeps> = {}): Promise<AgentDeps> {
  const store = new FlatFileVectorStore(path.join(tmp, `agent-emb-${Math.random().toString(36).slice(2)}.json`));
  const emb = new LocalHashEmbedding();
  await reindexAll(
    { emb, store } as IndexDeps,
    CATALOG.map((c) => ({ item: c.item, attrs: c.attrs })),
  );
  return {
    provider: mockProvider,
    emb,
    store,
    getItem: (id) => {
      const row: EvalCatalogItem | undefined = CATALOG.find((c) => c.item.id === id);
      return row ? { id: row.item.id, name: row.item.name, category: row.item.category } : null;
    },
    getAttrs: (id) => CATALOG.find((c) => c.item.id === id)?.attrs ?? null,
    getCatalog: () => CATALOG.map((c) => c.item.id),
    weather: new MockWeatherProvider({ temperatureC: 4 }), // a cool day
    preferences: new MockPreferencesProvider(),
    decide: mockAgentDecisionProvider,
    ...over,
  };
}

// ── 1 · tool schemas + allowlist ──────────────────────────────────────────────

test("parseAgentDecision accepts every allowlisted tool and rejects unknown actions", () => {
  const good: Array<[string, () => boolean]> = [
    ["search_wardrobe", () => parseAgentDecision({ action: "search_wardrobe", arguments: { query: "shirt", constraints: { colors: ["black"] } } }).ok],
    ["get_weather (no args)", () => parseAgentDecision({ action: "get_weather" }).ok],
    ["get_weather (location)", () => parseAgentDecision({ action: "get_weather", arguments: { location: "Shanghai" } }).ok],
    ["get_user_preferences", () => parseAgentDecision({ action: "get_user_preferences", arguments: {} }).ok],
    ["generate_outfit (subset)", () => parseAgentDecision({ action: "generate_outfit", arguments: { itemIds: ["t1"] } }).ok],
    ["generate_outfit (empty selection)", () => parseAgentDecision({ action: "generate_outfit", arguments: {} }).ok],
    ["validate_outfit", () => parseAgentDecision({ action: "validate_outfit", arguments: { itemIds: ["t1", "b2"] } }).ok],
    ["finish (success)", () => parseAgentDecision({ action: "finish", arguments: { status: "success", itemIds: ["t1", "b2"] } }).ok],
    ["finish (no-valid)", () => parseAgentDecision({ action: "finish", arguments: { status: "no-valid" } }).ok],
  ];
  for (const [name, run] of good) assert.equal(run(), true, `expected ${name} to be allowlisted + validated`);
});

test("unknown actions and malformed arguments are structurally rejected", () => {
  assert.equal(agentDecisionRawSchema.safeParse({ action: "fly_to_moon", arguments: {} }).success, false);
  assert.equal(agentDecisionRawSchema.safeParse({ action: "reeze_wardrobe" }).success, false);
  assert.equal(agentDecisionRawSchema.safeParse({ action: "search_wardrobe", arguments: { query: 42 } }).success, false);
  assert.equal(agentDecisionRawSchema.safeParse({ action: "finish", arguments: { status: "explode" } }).success, false);
  assert.equal(agentDecisionRawSchema.safeParse({ action: "validate_outfit", arguments: { itemIds: "t1" } }).success, false);
  assert.equal(agentDecisionRawSchema.safeParse({ action: 7 }).success, false);
  // arguments default to {} and are canonicalized (never a failure path)
  const parsed = parseAgentDecision({ action: "generate_outfit" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.decision.arguments, {});
});

// ── 2 · dynamic tool selection — ordinary request ────────────────────────────

test("ordinary request: search → generate → validate → finish; weather/prefs never called", async () => {
  const deps = await depsFor();
  const r = await runAgent("I need a black turtleneck with jeans for winter", deps, { timeoutMs: 30_000 });
  assert.equal(r.ok, true, `expected ok, got ${r.reason}`);
  const tools = r.trace.map((t) => t.tool);
  assert.deepEqual(tools, ["search_wardrobe", "generate_outfit", "validate_outfit", "finish"]);
  assert.equal(tools.includes("get_weather"), false, "weather is not warranted by this request");
  assert.equal(tools.includes("get_user_preferences"), false, "preferences are not warranted by this request");
  assert.equal(r.terminationReason, "valid-outfit");
  assert.equal(r.decisionProvider, "mock-policy");
  assert.ok(r.trace.every((t) => t.success), "all tools succeed on the happy path");
  assert.equal(r.iterationCount, 4);
  assert.equal(r.toolCallCount, 4);
});

// ── 3 · weather-dependent request calls get_weather FIRST ────────────────────

test("weather request calls get_weather before anything else", async () => {
  const deps = await depsFor();
  const r = await runAgent("what should I wear today — is it cold outside?", deps, { timeoutMs: 30_000 });
  assert.equal(r.trace[0]?.tool, "get_weather");
  assert.ok(r.trace.some((t) => t.tool === "get_weather" && t.success));
  const tools = r.trace.map((t) => t.tool);
  assert.deepEqual(tools, ["get_weather", "search_wardrobe", "generate_outfit", "validate_outfit", "finish"]);
  assert.equal(r.terminationReason, "valid-outfit");
});

// ── 4 · preferences request calls get_user_preferences FIRST ────────────────

test("preferences request calls get_user_preferences first", async () => {
  const deps = await depsFor();
  const r = await runAgent("an outfit for me with a top and jeans", deps, { timeoutMs: 30_000 });
  assert.equal(r.trace[0]?.tool, "get_user_preferences");
  assert.ok(r.trace.some((t) => t.tool === "get_user_preferences" && t.success));
  const tools = r.trace.map((t) => t.tool);
  assert.deepEqual(tools, ["get_user_preferences", "search_wardrobe", "generate_outfit", "validate_outfit", "finish"]);
  assert.equal(r.terminationReason, "valid-outfit");
});

// ── 5 · validation failure → bounded retry, hard constraints never relaxed ───

test("validation failure triggers one retry; hard constraints stay identical", async () => {
  const deps = await depsFor();
  // black + summer only admits t5 (tank), b4 (shorts) and s3 (canvas sneakers
  // tagged cool/mild) — the weather guard rejects s3, so validation fails and
  // the planner retries the SAME hard set once, then terminates no-valid.
  const r = await runAgent("give me a black summer outfit", deps, { timeoutMs: 30_000 });
  const tools = r.trace.map((t) => t.tool);
  assert.deepEqual(
    tools,
    ["search_wardrobe", "generate_outfit", "validate_outfit", "search_wardrobe", "generate_outfit", "validate_outfit", "finish"],
  );
  assert.equal(r.terminationReason, "no-valid-outfit");
  assert.equal(r.ok, false);

  // hard preservation: every search saw the SAME black+summer constraint set.
  const searchConstraints = r.trace.filter((t) => t.tool === "search_wardrobe").map((t) => JSON.stringify(t.searchConstraints));
  assert.equal(searchConstraints.length, 2);
  assert.equal(searchConstraints[0], searchConstraints[1], "the second search may not relax the hard set");
  const expected = JSON.stringify({ colors: ["black"], seasons: ["summer"] });
  assert.equal(searchConstraints[0], expected);

  // the final look still shows the failing guard (observable reason).
  assert.ok(r.reason.includes("pieces suit the requested weather"), "reason names the rejecting weather guard");
});

// ── 6 · zero-result → retry once with the SAME hard set, then unsatisfiable ──

test("zero-result request retries once and terminates unsatisfiable (hard never relaxed)", async () => {
  const deps = await depsFor();
  // The catalog deliberately has NO bags.
  const r = await runAgent("an elegant black handbag", deps, { timeoutMs: 30_000 });
  const tools = r.trace.map((t) => t.tool);
  assert.deepEqual(tools, ["search_wardrobe", "search_wardrobe", "finish"]);
  assert.equal(r.terminationReason, "unsatisfiable");
  assert.equal(r.ok, false);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.hard.categories, ["bags"]);
  assert.deepEqual(r.hard.colors, ["black"]);
  const searchConstraints = r.trace.filter((t) => t.tool === "search_wardrobe").map((t) => JSON.stringify(t.searchConstraints));
  assert.equal(searchConstraints.length, 2);
  assert.equal(searchConstraints[0], searchConstraints[1]);
});

// ── 7 · mergeConstraints is union-only (never relaxes) ───────────────────────

test("mergeConstraints adds values but never removes them", () => {
  const base = { colors: ["black"], seasons: ["winter"] } as import("../../retrieval/types").MetadataConstraints;
  const merged = mergeConstraints(base, { colors: ["black", "grey"], categories: ["tops"] });
  assert.deepEqual(merged.colors, ["black", "grey"]);
  assert.deepEqual(merged.seasons, ["winter"]);
  assert.deepEqual(merged.categories, ["tops"]);
  // a narrower extra cannot shrink the base
  const merged2 = mergeConstraints(base, { colors: ["black"] });
  assert.deepEqual(merged2.colors, ["black"]);
  // empty/undefined extra leaves the base untouched
  const merged3 = mergeConstraints(base);
  assert.deepEqual(merged3, base);
});

// ── 8 · max-iterations protection ────────────────────────────────────────────

test("an always-search decision loop hits max-iterations and stops", async () => {
  const deps = await depsFor({
    decide: () => Promise.resolve({ action: "search_wardrobe", arguments: {} } as const),
  });
  const r = await runAgent("a crew neck tee with jeans", deps, { maxIterations: 4, timeoutMs: 30_000 });
  assert.equal(r.terminationReason, "max-iterations");
  assert.equal(r.ok, false);
  assert.equal(r.iterationCount, 4);
  assert.equal(r.toolCallCount, 4);
  assert.ok(r.trace.every((t) => t.tool === "search_wardrobe"), "every tool call was the loop's own search");
});

// ── 9 · timeout protection ───────────────────────────────────────────────────

test("deadline enforcement terminates with 'timeout' even mid-loop", async () => {
  // now() moves far past any deadline on its second call.
  let calls = 0;
  const deps = await depsFor({ now: () => (++calls === 1 ? 0 : 100_000) });
  const r = await runAgent("a relaxed outfit", deps, { timeoutMs: 30_000 });
  assert.equal(r.terminationReason, "timeout");
  assert.equal(r.ok, false);
  assert.equal(r.toolCallCount, 0, "no tool executes once the deadline is passed");
});

// ── 10 · invalid tool call / decision-layer incoherence ──────────────────────

test("unparseable decisions terminate with 'invalid-tool-call' after one re-decision", async () => {
  const deps = await depsFor({
    decide: () => Promise.resolve({ action: "running_man", arguments: { speed: "max" } } as never),
  });
  const r = await runAgent("any outfit", deps, { timeoutMs: 30_000 });
  assert.equal(r.terminationReason, "invalid-tool-call");
  assert.equal(r.ok, false);
  assert.equal(r.trace.length, 0, "an invalid decision never executes a tool");
});

// ── 11 · stale vector protection ─────────────────────────────────────────────

test("a stale vector (ghost item) never surfaces in candidates, the look, or telemetry", async () => {
  const deps = await depsFor();
  // plant a ghost vector identical to t1's text — it will rank at the top.
  const t1rec = deps.store.get("t1")!;
  deps.store.upsert({ ...t1rec, itemId: "ghost-t1", text: t1rec.text, createdAt: t1rec.createdAt, updatedAt: t1rec.updatedAt });

  const r = await runAgent("a crew neck tee with jeans", deps, { timeoutMs: 30_000 });
  assert.equal(r.ok, true);
  for (const item of r.items) {
    assert.notEqual(item.id, "ghost-t1");
    assert.ok(ALL_IDS.has(item.id), `item ${item.id} must be a live catalog id`);
  }
  const allToolResults = r.trace.map((t) => t.summary).join(" ");
  assert.equal(allToolResults.includes("ghost"), false, "trace summaries must not leak ghost ids");
  assert.ok(r.items.some((i) => i.id === "t1"), "the real t1 is still reachable");
});

// ── 12 · final grounding — deterministic validation stays authoritative ───────

test("final grounding: every recommended id is live and the look still passes deterministic validation", async () => {
  const deps = await depsFor();
  const r = await runAgent("black turtleneck with jeans", deps, { timeoutMs: 30_000 });
  assert.equal(r.ok, true);
  assert.equal(r.terminationReason, "valid-outfit");
  const det = validateOutfitDeterministic({
    requested: r.items,
    constraints: r.hard,
    wardrobeIds: new Set(deps.getCatalog()),
    getItem: deps.getItem,
    getAttrs: deps.getAttrs,
  });
  assert.equal(det.passed, true, "the runner's deterministic closure must agree");
  for (const item of r.items) assert.ok(ALL_IDS.has(item.id), `item ${item.id} must be live`);
  // no duplicate ids
  assert.equal(new Set(r.items.map((i) => i.id)).size, r.items.length);
  // hard constraints satisfied by every returned item (the same check retrieval used)
  for (const item of r.items) {
    const itemRec = deps.getItem(item.id);
    assert.ok(itemRec, `item ${item.id} must resolve`);
    assert.equal(matchesConstraints(itemRec, deps.getAttrs(item.id), r.hard), true, `item ${item.id} must satisfy the hard set`);
  }
});

// ── 13 · decision layer is a replaceable seam (LLM-shaped decision uses the same allowlist) ──

test("a from-scratch LLM-shaped decision layer still funnels through the zod allowlist", async () => {
  const deps = await depsFor({
    decide: (state) =>
      Promise.resolve(
        state.candidates
          ? { action: "validate_outfit", arguments: { itemIds: state.candidates.map((c) => c.itemId).slice(0, 4) } }
          : { action: "search_wardrobe", arguments: {} },
      ),
  });
  // a hard-coded fixed sequence is NOT a valid agent — but this one branches on
  // state (empty candidates → search) so it exercises the allowlist path too.
  const r = await runAgent("some top and trousers", deps, { timeoutMs: 30_000 });
  assert.ok(["valid-outfit", "no-valid-outfit", "max-iterations"].includes(r.terminationReason));
  assert.equal(r.decisionProvider, "mock-policy");
  assert.ok(r.trace[0]?.tool === "search_wardrobe");
});

// ── 14 · tool schema version is surfaced on the run ─────────────────────────

test("runs surface the allowlisted tool schema version", async () => {
  const deps = await depsFor();
  const r = await runAgent("a top", deps, { timeoutMs: 30_000 });
  assert.equal(r.meta.toolSchemaVersion, AGENT_TOOL_SCHEMA_VERSION);
});

// ── 15 · every run has a structured termination reason ───────────────────────

test("every trajectory terminates with a valid structured reason", async () => {
  const requests = [
    "a relaxed outfit",
    "today I need warm winter clothes",
    "show me my style preferences and a look",
    "a black summer outfit",
    "an elegant handbag",
  ];
  for (const q of requests) {
    const deps = await depsFor();
    const r = await runAgent(q, deps, { timeoutMs: 30_000 });
    assert.match(r.terminationReason ?? "", /^(valid-outfit|no-valid-outfit|unsatisfiable|max-iterations|timeout|tool-unavailable|invalid-tool-call)$/, q);
  }
});