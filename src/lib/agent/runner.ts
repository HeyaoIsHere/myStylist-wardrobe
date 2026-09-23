import { AIProviderError, type AIErrorCategory, type TokenUsage } from "../ai/provider";
import { extractDeterministicSuggestions } from "../recommend/deterministic";
import { validateOutfitDeterministic } from "../recommend/validate";
import { sha256 } from "../retrieval/search";
import { logAgentRun, logAgentTool } from "../telemetry";
import { parseAgentDecision } from "./schema";
import { createInitialState, patchState } from "./state";
import { runTool, runFinish } from "./tools";
import { AGENT_TOOL_SCHEMA_VERSION } from "./types";
import type {
  AgentDeps,
  AgentResult,
  AgentRunConfig,
  AgentState,
  AgentTraceRecord,
  OutfitItemView,
  RawAgentDecision,
} from "./types";

/**
 * The bounded agent loop (Phase 6).
 *
 *   loop (bounded by maxIterations + deadline):
 *     decide  → (state) → {action, arguments}            [decision layer]
 *     validate→ zod + allowlist; reject safely            [runner]
 *     execute → tool handler over existing seams          [tools.ts]
 *     observe → updated state + sanitized trace
 *
 * Termination: every run ends with a structured `terminationReason` from the
 * closed set; the loop cannot spin (budget + deadline) and cannot pick an
 * unlisted tool (zod discriminated union). Deterministic validation is
 * re-applied to the final look HERE — it stays authoritative no matter what
 * the decision layer did.
 */

export const DEFAULT_MAX_ITERATIONS = 8;
export const DEFAULT_TIMEOUT_MS = 30_000;

function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!b) return a;
  if (!a) return b;
  const sum = (x: number | undefined, y: number | undefined) => (x ?? 0) + (y ?? 0);
  const out: TokenUsage = {
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
  };
  if (a.costUsd !== undefined || b.costUsd !== undefined) out.costUsd = sum(a.costUsd, b.costUsd);
  return out;
}

/** Resolve the final, grounded items the run surfaces. */
function finalItemViews(state: AgentState, deps: AgentDeps): OutfitItemView[] {
  const ids = (state.generated ?? []).map((v) => v.id);
  const generated = new Map((state.generated ?? []).map((v) => [v.id, v] as const));
  const out: OutfitItemView[] = [];
  for (const id of ids) {
    if (generated.has(id)) out.push(generated.get(id)!);
    else {
      const item = deps.getItem(id);
      if (item) {
        const cand = (state.candidates ?? []).find((c) => c.itemId === id);
        out.push({ id, name: item.name, category: item.category, role: "other", score: cand?.score ?? 0 });
      }
    }
  }
  return out;
}

function capitalize(s: string): string {
  return /^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function titleFor(state: AgentState): string {
  const season = state.hard.seasons?.[0];
  const occ = state.hard.occasions?.[0];
  const bit = season ? capitalize(season) : occ ? capitalize(occ) : "Agent";
  return state.terminationReason === "valid-outfit" ? `${bit} look` : "No recommendation";
}

function reasonFor(state: AgentState, failedGuardLabels: string[]): string {
  switch (state.terminationReason) {
    case "valid-outfit":
      return "A grounded outfit from your wardrobe passed deterministic validation.";
    case "unsatisfiable":
      return "No wardrobe items satisfy the requested hard constraints (constraints are never relaxed).";
    case "no-valid-outfit":
      return failedGuardLabels.length
        ? `No valid look could be composed within the hard constraints — the last attempt was rejected by: ${failedGuardLabels.join("; ")}.`
        : "No valid look could be composed within the available wardrobe and hard constraints.";
    case "max-iterations":
      return "The planner reached its iteration budget before a validated outfit was found.";
    case "timeout":
      return "The planner hit its time deadline before a validated outfit was found.";
    case "tool-unavailable":
      return "A required tool or provider was unavailable; the planner stopped safely.";
    case "invalid-tool-call":
      return "The planner produced no valid tool decision; the run stopped safely.";
    case null:
      return "The planner did not reach a decision.";
  }
}

export async function runAgent(raw: string, deps: AgentDeps, config: AgentRunConfig = {}): Promise<AgentResult> {
  const maxIterations = Math.max(1, config.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const requestId = crypto.randomUUID();
  const agentRunId = crypto.randomUUID();
  const startedAt = now();
  const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY;

  const seed = extractDeterministicSuggestions(raw);
  let state = createInitialState(requestId, startedAt, raw, seed.hard);

  let decisionUsage: TokenUsage | null = null;
  let decisionModel: string | null = null;
  let errorCategory: AIErrorCategory | null = null;
  const onUsage = (u: TokenUsage) => {
    decisionUsage = mergeUsage(decisionUsage, u);
  };
  const onModel = (m: string) => {
    decisionModel = m;
  };

  while (state.iteration < maxIterations && state.terminationReason === null) {
    if (now() >= deadline) {
      state = patchState(state, { terminationReason: "timeout" });
      break;
    }

    // 1. decide
    let rawDecision: RawAgentDecision;
    try {
      rawDecision = await deps.decide(state, { provider: deps.provider, onUsage, onModel });
    } catch (err) {
      errorCategory = err instanceof AIProviderError ? err.category : "unknown";
      state = patchState(state, { terminationReason: "tool-unavailable" });
      logAgentTool({
        agentRunId,
        queryHash: sha256(raw).slice(0, 16),
        iteration: state.iteration + 1,
        toolName: "decision-provider",
        toolInputSchemaVersion: AGENT_TOOL_SCHEMA_VERSION,
        toolSuccess: false,
        toolResultSummary: `decision provider failed (${errorCategory})`,
        agentTerminationReason: "tool-unavailable",
      });
      break;
    }

    // 2. validate the decision (allowlist + zod)
    const parsed = parseAgentDecision(rawDecision);
    if (!parsed.ok) {
      if (state.iteration + 1 >= maxIterations) {
        state = patchState(state, { terminationReason: "invalid-tool-call" });
        break;
      }
      // Re-decide once; if the second attempt is also invalid we terminate.
      let re: RawAgentDecision;
      try {
        re = await deps.decide(state, { provider: deps.provider, onUsage, onModel });
      } catch (err) {
        errorCategory = err instanceof AIProviderError ? err.category : "unknown";
        state = patchState(state, { terminationReason: "tool-unavailable" });
        break;
      }
      const reparsed = parseAgentDecision(re);
      if (!reparsed.ok) {
        state = patchState(state, { terminationReason: "invalid-tool-call" });
        break;
      }
      const r2 = await runOne(reparsed.decision, state, deps, agentRunId, raw, now(), deadline);
      state = r2.state;
      if (r2.stop) break;
      continue;
    }

    // 3. execute
    const r = await runOne(parsed.decision, state, deps, agentRunId, raw, now(), deadline);
    state = r.state;
    if (!r.success) {
      errorCategory = "unknown";
      state = patchState(state, { terminationReason: "tool-unavailable" });
      break;
    }
    if (r.stop) break;
  }

  if (state.iteration >= maxIterations && state.terminationReason === null) {
    state = patchState(state, { terminationReason: "max-iterations" });
  }

  // ── Authoritative closure ── (the runner always re-runs deterministic validation)
  const finalItems = finalItemViews(state, deps);
  const finalDet = validateOutfitDeterministic({
    requested: finalItems,
    constraints: state.hard,
    wardrobeIds: new Set(deps.getCatalog()),
    getItem: deps.getItem,
    getAttrs: deps.getAttrs,
  });
  // semantic verdict from the agent's own validation record, if it covers the final look
  const semPassed =
    state.validation && sameIds(state.validation.itemIds, finalItems)
      ? state.validation.semantic.passed
      : null;

  const ok = state.terminationReason === "valid-outfit" && finalDet.passed && semPassed !== false;

  const usage = mergeUsage(decisionUsage, state.validation?.semantic.usage ?? null);
  const durationMs = now() - startedAt;
  const decisionProvider = deps.provider.name === "mock" ? "mock-policy" : deps.provider.name;
  const model = decisionModel ?? deps.provider.name;

  const trace = state.trace;
  logAgentRun({
    agentRunId,
    requestId,
    queryHash: sha256(raw).slice(0, 16),
    terminationReason: state.terminationReason!,
    decisionProvider,
    provider: deps.provider.name,
    model,
    toolCalls: trace.length,
    iterations: state.iteration,
    latencyMs: durationMs,
    usage,
    grounded: finalItems.length >= 2,
    itemCount: finalItems.length,
    ok,
    errorCategory,
    trajectory: trace.map((t) => t.tool),
  });

  return {
    ok,
    kind: "agent",
    title: titleFor(state),
    reason: reasonFor(state, finalDet.checks.filter((c) => !c.passed).map((c) => c.label)),
    items: finalItems,
    hard: state.hard,
    terminationReason: state.terminationReason!,
    trace,
    iterationCount: state.iteration,
    toolCallCount: trace.length,
    durationMs,
    decisionProvider,
    validation: state.validation,
    meta: {
      agentRunId,
      requestId,
      provider: deps.provider.name,
      model,
      toolSchemaVersion: config.toolSchemaVersion ?? AGENT_TOOL_SCHEMA_VERSION,
      latencyMs: durationMs,
      usage,
      errorCategory,
    },
  };
}

function sameIds(a: string[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x.id));
}

interface OneStep {
  state: AgentState;
  stop: boolean;
  success: boolean;
}

async function runOne(
  decision: import("./schema").AgentDecision,
  state: AgentState,
  deps: AgentDeps,
  agentRunId: string,
  raw: string,
  at: number,
  deadline: number,
): Promise<OneStep> {
  // deadline check before executing any tool
  if (now2(at) >= deadline) {
    const s = patchState(state, { terminationReason: "timeout" });
    return { state: s, stop: true, success: false };
  }

  if (decision.action === "finish") {
    const res = await runFinish(state, decision.arguments, deps);
    const iteration = state.iteration + 1;
    const record: AgentTraceRecord = {
      iteration,
      tool: "finish",
      success: res.success,
      summary: res.summary,
      ...res.traceExtra,
    };
    const s = patchState(res.state, { iteration, trace: [...state.trace, record] });
    logAgentTool({
      agentRunId,
      queryHash: sha256(raw).slice(0, 16),
      iteration,
      toolName: "finish",
      toolInputSchemaVersion: AGENT_TOOL_SCHEMA_VERSION,
      toolSuccess: res.success,
      toolResultSummary: res.summary,
      agentTerminationReason: s.terminationReason,
    });
    // A finish (whatever status) terminates the run.
    return { state: s, stop: true, success: res.success };
  }

  const res = await runTool(decision.action, state, decision.arguments, deps);
  const iteration = state.iteration + 1;
  const record: AgentTraceRecord = {
    iteration,
    tool: decision.action,
    success: res.success,
    summary: res.summary,
    ...res.traceExtra,
  };
  const s = patchState(res.state, { iteration, trace: [...state.trace, record] });
  logAgentTool({
    agentRunId,
    queryHash: sha256(raw).slice(0, 16),
    iteration,
    toolName: decision.action,
    toolInputSchemaVersion: AGENT_TOOL_SCHEMA_VERSION,
    toolSuccess: res.success,
    toolResultSummary: res.summary,
    agentTerminationReason: null,
  });
  return { state: s, stop: false, success: res.success };
}

const now2 = (n: number) => n;

export type AgentToolName = import("./types").AgentToolName;