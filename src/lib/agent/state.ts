import type { MetadataConstraints } from "../retrieval/types";
import type { OutfitQuery } from "../recommend/types";
import { weatherDescriptor } from "./weather";
import type { AgentState } from "./types";

/**
 * Agent state helpers (Phase 6): a tiny immutable-ish state model. State is
 * STRICTLY structured (the decision layer + telemetry observe it); no free-form
 * reasoning, no chain-of-thought is ever stored here.
 */

/** Create the initial state from a user request (deterministic extractor seeds
 *  the frozen hard constraints BEFORE any model call — D-06 discipline). */
export function createInitialState(
  requestId: string,
  startedAt: number,
  raw: string,
  hard: MetadataConstraints,
): AgentState {
  const text = raw.trim();
  return {
    requestId,
    startedAt,
    userRequest: text,
    hard,
    soft: text ? [text.slice(0, 400)] : [],
    weather: null,
    preferences: null,
    candidates: null,
    lastSearch: null,
    generated: null,
    validation: null,
    searchAttempts: 0,
    trace: [],
    iteration: 0,
    terminationReason: null,
  };
}

/** Merge — the ONLY way hard constraints change: a tool may add values, never
 *  remove them. `state.hard` therefore monotonically grows within a run. */
export function mergeConstraints(base: MetadataConstraints, extra?: MetadataConstraints): MetadataConstraints {
  if (!extra) return { ...base };
  const out: MetadataConstraints = { ...base };
  const uniq = <T,>(a: T[] = [], b: T[] = []): T[] => [...new Set([...a, ...b])] as T[];
  if (extra.categories?.length) out.categories = uniq(out.categories, extra.categories);
  if (extra.colors?.length) out.colors = uniq(out.colors, extra.colors);
  if (extra.materials?.length) out.materials = uniq(out.materials, extra.materials);
  if (extra.seasons?.length) out.seasons = uniq(out.seasons, extra.seasons);
  if (extra.occasions?.length) out.occasions = uniq(out.occasions, extra.occasions);
  if (extra.formality) out.formality = extra.formality;
  if (extra.excludeIds?.length) out.excludeIds = uniq(out.excludeIds, extra.excludeIds);
  return out;
}

/** Soft signals that ride the query TEXT (never the filter). */
export function softFor(state: AgentState): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...state.soft, ...(state.preferences?.styleSignals ?? [])]) {
    const t = s.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  const w = weatherDescriptor(state.weather).trim();
  if (w && !seen.has(w)) out.push(w);
  return out.slice(0, 8);
}

/** The OutfitQuery the agent hands to the shared compose/validate seams. */
export function buildAgentQuery(state: AgentState): OutfitQuery {
  return {
    raw: state.userRequest,
    hard: state.hard,
    soft: softFor(state),
    context: {},
    parsedBy: "deterministic",
  };
}

/** True when any hard constraint field is populated. */
export function hasHardConstraints(hard: MetadataConstraints): boolean {
  return Boolean(
    hard.categories?.length || hard.colors?.length || hard.materials?.length ||
      hard.seasons?.length || hard.occasions?.length || hard.formality || hard.excludeIds?.length,
  );
}

/** Copy state with a patch (tools never mutate in place). */
export function patchState(state: AgentState, patch: Partial<AgentState>): AgentState {
  return { ...state, ...patch };
}