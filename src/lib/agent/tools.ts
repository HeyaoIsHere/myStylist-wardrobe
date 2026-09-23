import type { AIErrorCategory } from "../ai/provider";
import { semanticSearch } from "../retrieval/search";
import type { Category } from "../types";
import { composeOutfit } from "../recommend/compose";
import { combineValidation, validateOutfitDeterministic } from "../recommend/validate";
import { semanticValidateOutfit, skippedSemanticValidation } from "../recommend/semantic";
import type { OutfitItemView, OutfitRole, SemanticValidation } from "../recommend/types";
import { buildAgentQuery, mergeConstraints, patchState, softFor } from "./state";
import { weatherDescriptor } from "./weather";
import type {
  AgentDeps,
  AgentFinishInput,
  AgentSearchInput,
  AgentState,
  AgentTerminationReason,
  AgentTraceRecord,
  AgentValidationOutcome,
} from "./types";

/**
 * The six allowlisted tools (Phase 6, section 3). Every handler is a THIN
 * adapter over an existing seam — retrieval (`semanticSearch`), composition
 * (`composeOutfit`), deterministic + advisory validation
 * (`validateOutfitDeterministic` / `semanticValidateOutfit`). Tool handlers
 * return a NEW state (immutably updated) plus a sanitized trace summary.
 *
 * Grounding gates enforced here (never by the decision layer):
 *   · search_wardrobe always passes an OBJECT constraint set (so the search
 *     lane's `getItem` liveness check strips ghosts at layer 1),
 *   · generate_outfit only ever picks ids that are members of the previous
 *     search's candidate set (live by construction),
 *   · validate_outfit re-resolves every id against the live catalog.
 */

const TOP_K = 12; // same as the deterministic pipeline's retrieveForOutfit.

const ROLE_OF: Record<Category, OutfitRole> = {
  dresses: "dress",
  tops: "top",
  bottoms: "bottom",
  outerwear: "outerwear",
  shoes: "shoes",
  bags: "bag",
  accessories: "accessory",
  others: "other",
};

export interface ToolResult {
  state: AgentState;
  success: boolean;
  summary: string;
  traceExtra?: Partial<Omit<AgentTraceRecord, "iteration" | "tool">>;
}

/** The query TEXT fed to embedded ranking: user request + soft signals. */
function queryText(state: AgentState, override?: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (t: string) => {
    const s = t.trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      parts.push(s);
    }
  };
  push(override ?? state.userRequest);
  for (const s of softFor(state)) push(s);
  return parts.join(" ");
}

function itemView(item: { id: string; name: string; category: Category }, score: number): OutfitItemView {
  return { id: item.id, name: item.name, category: item.category, role: ROLE_OF[item.category] ?? "other", score: Math.round(score * 10000) / 10000 };
}

function viewFromCandidate(deps: AgentDeps, id: string, score: number): OutfitItemView | null {
  const item = deps.getItem(id);
  if (!item) return null;
  return itemView(item, score);
}

/** Grounded views for arbitrary ids — only never-invented, live ids survive. */
function resolveViews(state: AgentState, deps: AgentDeps, ids: string[]): Map<string, OutfitItemView> {
  const generated = new Map((state.generated ?? []).map((v) => [v.id, v] as const));
  const out = new Map<string, OutfitItemView>();
  for (const id of ids) {
    if (generated.has(id)) {
      out.set(id, generated.get(id)!);
      continue;
    }
    const cand = state.candidates?.find((c) => c.itemId === id);
    if (cand) {
      const view = viewFromCandidate(deps, id, cand.score);
      if (view) out.set(id, view);
    }
  }
  return out;
}

// ── search_wardrobe ──────────────────────────────────────────────────────────

async function runSearch(
  state: AgentState,
  args: AgentSearchInput,
  deps: AgentDeps,
): Promise<ToolResult> {
  const effective = mergeConstraints(state.hard, args.constraints);
  const text = queryText(state, args.query);
  const searchDeps = {
    emb: deps.emb,
    store: deps.store,
    getItem: (id: string) => {
      const item = deps.getItem(id);
      return item ? { id: item.id, category: item.category } : null;
    },
    getAttrs: deps.getAttrs,
  };
  const result = await semanticSearch(searchDeps, { query: text, constraints: effective, topK: TOP_K });

  const candidates = result.hits.map((h) => ({ itemId: h.itemId, score: h.score }));
  const next = patchState(state, {
    candidates,
    lastSearch: {
      query: text,
      constraints: effective,
      candidateCount: result.meta.candidateCount,
      degraded: result.meta.degraded,
    },
    // New evidence invalidates any prior generation / verdict.
    generated: null,
    validation: null,
    searchAttempts: state.searchAttempts + 1,
  });

  return {
    state: next,
    success: !result.meta.degraded,
    summary: result.meta.degraded
      ? `search degraded (${result.meta.errorCategory ?? "unknown"})`
      : `search candidates=${result.meta.candidateCount} (ranked ${candidates.length})`,
    traceExtra: {
      candidateCount: result.meta.candidateCount,
      searchConstraints: effective,
    },
  };
}

// ── get_weather / get_user_preferences ───────────────────────────────────────

async function runGetWeather(
  state: AgentState,
  args: { location?: string },
  deps: AgentDeps,
): Promise<ToolResult> {
  try {
    const report = await deps.weather.getWeather(args.location);
    const next = patchState(state, { weather: report });
    return {
      state: next,
      success: true,
      summary: `weather ${report.condition} ${report.temperatureC}C (${weatherDescriptor(report)})`,
    };
  } catch {
    return { state, success: false, summary: "weather provider unavailable" };
  }
}

async function runGetPreferences(state: AgentState, deps: AgentDeps): Promise<ToolResult> {
  try {
    const prefs = await deps.preferences.getPreferences();
    const next = patchState(state, { preferences: prefs });
    return {
      state: next,
      success: true,
      summary: `preferences signals=${prefs.styleSignals.length} (${prefs.source})`,
    };
  } catch {
    return { state, success: false, summary: "preferences provider unavailable" };
  }
}

// ── generate_outfit ──────────────────────────────────────────────────────────

async function runGenerate(
  state: AgentState,
  args: { itemIds?: string[] },
  deps: AgentDeps,
): Promise<ToolResult> {
  const candidates = state.candidates ?? [];
  if (candidates.length === 0) {
    return { state, success: false, summary: "generate: no candidates from a prior search" };
  }

  // The model may pass a subset of the candidate ids; unknown ids are DROPPED
  // (grounding). An empty selection defaults to the full candidate set.
  const candMap = new Map(candidates.map((c) => [c.itemId, c.score] as const));
  const chosen =
    args.itemIds && args.itemIds.length > 0
      ? args.itemIds.filter((id) => candMap.has(id))
      : candidates.map((c) => c.itemId);
  const dropped = args.itemIds && args.itemIds.length > 0 ? args.itemIds.filter((id) => !candMap.has(id)) : [];

  const hits = candidates.filter((c) => chosen.includes(c.itemId));
  const composed = composeOutfit({
    query: buildAgentQuery(state),
    hits,
    getItem: deps.getItem,
  });

  const next = patchState(state, { generated: composed.items, validation: null });
  return {
    state: next,
    success: true,
    summary: `generate items=${composed.items.length}${dropped.length ? ` (${dropped.length} unknown requested ids dropped)` : ""} :: ${composed.reason}`,
    traceExtra: { generatedCount: composed.items.length },
  };
}

// ── validate_outfit ──────────────────────────────────────────────────────────

async function runValidate(
  state: AgentState,
  args: { itemIds: string[]; context?: { occasion?: string; mood?: string; note?: string } },
  deps: AgentDeps,
): Promise<ToolResult> {
  // An empty target defaults to the CURRENT generation (same discipline as
  // generate/finish): "validate the look we just composed". The ids are the
  // previous tool result's — already grounded by construction.
  const targetIds = args.itemIds && args.itemIds.length > 0 ? args.itemIds : (state.generated ?? []).map((v) => v.id);
  const views = resolveViews(state, deps, targetIds);
  const dropped = args.itemIds?.filter((id) => !views.has(id)) ?? [];
  const requested = [...views.values()];
  const wardrobeIds = new Set(deps.getCatalog());

  // ARTIFICIAL but explicit: validate requires a real ≥1-piece target. An
  // invalid target is reported (the decision layer then re-searches/finishes).
  if (requested.length === 0) {
    return {
      state,
      success: true,
      summary: `validate: no grounded item ids in target (${dropped.length} unknown)`,
      traceExtra: { validationDetPassed: false, validationSemPassed: null, validationScore: null },
    };
  }

  const deterministic = validateOutfitDeterministic({
    requested,
    constraints: state.hard,
    wardrobeIds,
    getItem: deps.getItem,
    getAttrs: deps.getAttrs,
  });

  const semantic: SemanticValidation =
    deterministic.passed
      ? await semanticValidateOutfit({
          items: requested,
          query: { ...buildAgentQuery(state), context: args.context ?? {} },
          provider: deps.provider,
          getAttrs: deps.getAttrs,
        })
      : skippedSemanticValidation("skipped: deterministic validation failed");

  const combined = combineValidation(deterministic, semantic);
  const outcome: AgentValidationOutcome = {
    itemIds: requested.map((v) => v.id),
    passed: combined.passed,
    deterministic,
    semantic,
    score: semantic.score ?? null,
  };
  const next = patchState(state, { validation: outcome });
  return {
    state: next,
    success: true,
    summary: `validate ${requested.length} item(s): det=${deterministic.passed ? "pass" : "fail"} sem=${semantic.run ? (semantic.passed === true ? "pass" : semantic.passed === false ? "fail" : "?") : "skip"}`,
    traceExtra: {
      validationDetPassed: deterministic.passed,
      validationSemPassed: semantic.passed,
      validationScore: semantic.score ?? null,
      generatedCount: requested.length,
    },
  };
}

// ── finish ───────────────────────────────────────────────────────────────────

export async function runFinish(
  state: AgentState,
  args: AgentFinishInput,
  deps: AgentDeps,
): Promise<ToolResult> {
  // The final answer: the agent's chosen ids (grounded) or the last generation.
  const candidatesSet = new Set((state.candidates ?? []).map((c) => c.itemId));
  const generatedIds = new Set((state.generated ?? []).map((v) => v.id));
  const finalIds =
    args.itemIds && args.itemIds.length > 0
      ? args.itemIds.filter((id) => candidatesSet.has(id) || generatedIds.has(id))
      : (state.generated ?? []).map((v) => v.id);
  const finalItems = [...resolveViews(state, deps, finalIds).values()];

  // Authoritative closure: the runner ALWAYS re-validates deterministically.
  const deterministic = validateOutfitDeterministic({
    requested: finalItems,
    constraints: state.hard,
    wardrobeIds: new Set(deps.getCatalog()),
    getItem: deps.getItem,
    getAttrs: deps.getAttrs,
  });

  let reason: AgentTerminationReason;
  switch (args.status) {
    case "unsatisfiable":
      reason = "unsatisfiable";
      break;
    case "no-valid":
      reason = "no-valid-outfit";
      break;
    case "success":
      reason = deterministic.passed ? "valid-outfit" : "no-valid-outfit";
      break;
    default:
      reason = deterministic.passed ? "valid-outfit" : "no-valid-outfit";
  }

  const next = patchState(state, {
    generated: finalItems,
    terminationReason: reason,
    validation: state.validation,
  });
  return {
    state: next,
    success: true,
    summary: `finish status=${args.status ?? "success"} reason=${reason} items=${finalItems.length} det=${deterministic.passed ? "pass" : "fail"}`,
    traceExtra: { validationDetPassed: deterministic.passed, generatedCount: finalItems.length },
  };
}

// ── Registry / dispatch ──────────────────────────────────────────────────────

export type ToolDispatcher = (
  action: "search_wardrobe" | "get_weather" | "get_user_preferences" | "generate_outfit" | "validate_outfit",
  state: AgentState,
  args: unknown,
  deps: AgentDeps,
) => Promise<ToolResult>;

/** The allowlisted tool dispatcher — the ONLY way a tool executes. */
export const runTool: ToolDispatcher = (action, state, args, deps) => {
  switch (action) {
    case "search_wardrobe":
      return runSearch(state, args as AgentSearchInput, deps);
    case "get_weather":
      return runGetWeather(state, args as { location?: string }, deps);
    case "get_user_preferences":
      return runGetPreferences(state, deps);
    case "generate_outfit":
      return runGenerate(state, args as { itemIds?: string[] }, deps);
    case "validate_outfit":
      return runValidate(state, args as { itemIds: string[] }, deps);
  }
};

export type { AIErrorCategory };