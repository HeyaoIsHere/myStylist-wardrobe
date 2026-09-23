import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentGoldenSchema,
  loadAgentGolden,
  loadCatalog,
  validateAgentGolden,
  agentCatalogSchema,
} from "../agent-golden";
import { readFileSync } from "node:fs";
import { runAgentEvaluation } from "../agent-runner";
import type { AgentEvalCaseResult } from "../agent-types";

/**
 * Phase 6 agent eval tests.
 *
 * These PIN the bounded agent's deterministic behavior against the versioned
 * AGENT golden set: exact tool trajectories, termination reasons, hard-constraint
 * stability across searches, and stale-vector grounding. Because the mock
 * decision policy is a pure function of observable state over the synthetic
 * catalog, every trajectory below is FIXED — a change that shifts any of them is
 * a regression caught here.
 */

function stripTiming(caseResult: AgentEvalCaseResult) {
  const { latencyMs, ...rest } = caseResult;
  void latencyMs;
  return rest;
}

describe("agent eval dataset integrity", () => {
  it("loads and validates the versioned agent golden set", () => {
    const g = loadAgentGolden("v1");
    assert.equal(g.schemaName, "mystylist-agent-eval-golden");
    assert.equal(g.schemaVersion, "1");
    assert.equal(g.cases.length, 6);
    validateAgentGolden(g, loadCatalog());
  });

  it("rejects agent-golden drift (unknown tool / bad termination fails the schema)", () => {
    const g = loadAgentGolden("v1");
    const brokenTool = {
      schemaName: "mystylist-agent-eval-golden",
      schemaVersion: "1",
      cases: [
        { ...g.cases[0], id: "drift-tool", expected: { ...g.cases[0]!.expected, trajectory: ["fly_to_moon"] } },
      ],
    };
    assert.equal(agentGoldenSchema.safeParse(brokenTool).success, false);

    const brokenTerm = {
      schemaName: "mystylist-agent-eval-golden",
      schemaVersion: "1",
      cases: [
        { ...g.cases[0], id: "drift-term", expected: { ...g.cases[0]!.expected, termination: "exploded" } },
      ],
    };
    assert.equal(agentGoldenSchema.safeParse(brokenTerm).success, false);
  });

  it("rejects catalog drift via the shared catalog schema", () => {
    const c = JSON.parse(readFileSync(join(process.cwd(), "scripts/eval/data/catalog.json"), "utf8"));
    const broken = { ...c, catalog: [{ ...c.catalog[0], item: { ...c.catalog[0].item, category: "capotes" } }] };
    assert.equal(agentCatalogSchema.safeParse(broken).success, false);
  });

  it("validateAgentGolden rejects duplicate ids and unknown ghost/relevant sources", () => {
    const g = loadAgentGolden("v1");
    const dup = { ...g, cases: [...g.cases, g.cases[1]!] };
    assert.throws(() => validateAgentGolden(dup, loadCatalog()));
    const badGhost = { ...g, cases: [{ ...g.cases[0]!, id: "x", seedGhosts: ["t999"] }] };
    assert.throws(() => validateAgentGolden(badGhost, loadCatalog()));
    const badRel = { ...g, cases: [{ ...g.cases[0]!, id: "y", expected: { ...g.cases[0]!.expected, relevantIds: ["t999"] } }] };
    assert.throws(() => validateAgentGolden(badRel, loadCatalog()));
  });
});

describe("agent eval full runs", () => {
  it("is deterministic across two runs (timing excluded)", async () => {
    const outA = join(mkdtempSync(join(tmpdir(), "agent-eval-det-a-")), "out");
    const outB = join(mkdtempSync(join(tmpdir(), "agent-eval-det-b-")), "out");
    const [reportA, reportB] = await Promise.all([
      runAgentEvaluation({ out: outA }),
      runAgentEvaluation({ out: outB }),
    ]);
    assert.deepEqual(
      reportA.cases.map(stripTiming),
      reportB.cases.map(stripTiming),
      "two runs must produce identical per-case results",
    );
    const metrics = (r: typeof reportA) => r.summary.metrics.filter((m) => m.kind !== "observability").map((m) => [m.id, m.value]);
    assert.deepEqual(metrics(reportA), metrics(reportB));
  });

  it("satisfies the agent golden-set guarantees", async () => {
    const report = await runAgentEvaluation({ out: join(mkdtempSync(join(tmpdir(), "agent-eval-guards-")), "out") });
    const metric = (id: string) => report.summary.metrics.find((m) => m.id === id)!.value;

    assert.equal(report.summary.totals.caseCount, 6);
    assert.equal(metric("agent_case_success_rate"), 1, "every case matches its full expectation set");
    assert.equal(metric("trajectory_match_rate"), 1, "every trajectory matches the golden exactly");
    assert.equal(metric("termination_match_rate"), 1);
    assert.equal(metric("ok_match_rate"), 1);
    assert.equal(metric("hard_preservation_rate"), 1, "no search ever relaxed the hard set");
    assert.equal(metric("stale_leak_rate"), 0, "no ghost id ever reached the final items");

    const byId = new Map(report.cases.map((c) => [c.caseId, c]));

    // weather request: get_weather MUST be the first tool; never search-first.
    const w = byId.get("agent-weather-01")!;
    assert.deepEqual(w.trajectory, ["get_weather", "search_wardrobe", "generate_outfit", "validate_outfit", "finish"]);
    assert.equal(w.termination, "valid-outfit");

    // prefs request: get_user_preferences MUST be first.
    const p = byId.get("agent-prefs-01")!;
    assert.deepEqual(p.trajectory, ["get_user_preferences", "search_wardrobe", "generate_outfit", "validate_outfit", "finish"]);

    // validation-failure retry: 7 calls, searches carried IDENTICAL constraints.
    const r = byId.get("agent-weather-retry-01")!;
    assert.deepEqual(r.trajectory, ["search_wardrobe", "generate_outfit", "validate_outfit", "search_wardrobe", "generate_outfit", "validate_outfit", "finish"]);
    assert.equal(r.termination, "no-valid-outfit");
    assert.equal(r.hardStable, true, "searchAttempts retry kept the hard set frozen");
    assert.deepEqual(r.candidateCounts, [3, 3], "both searches saw the same candidate pool");

    // zero-result: retried once (2 searches), then unsatisfiable with the hard set preserved.
    const z = byId.get("agent-zero-zh-01")!;
    assert.deepEqual(z.trajectory, ["search_wardrobe", "search_wardrobe", "finish"]);
    assert.equal(z.termination, "unsatisfiable");
    assert.deepEqual(z.itemIds, []);
    assert.ok(z.parsedHard.categories?.includes("bags"), "bags hard constraint carried through");
    assert.equal(z.hardStable, true);

    // stale: live t1 recommended, no ghost.
    const s = byId.get("agent-stale-01")!;
    assert.equal(s.ok, true);
    assert.ok(s.itemIds.includes("t1"), "the real item is still reachable");
    assert.ok(!s.itemIds.some((i) => i.startsWith("ghost-")), "no ghost leaked");
  });
});