import { AIProviderError, type AIProvider, type TokenUsage } from "../ai/provider";
import { extractJsonObject } from "../metadata/service";
import {
  buildDecisionSystemPrompt,
  buildDecisionUserText,
  AGENT_DECISION_SCHEMA_VERSION,
} from "./prompt";
import type {
  AgentDecisionContext,
  AgentDecisionProvider,
  AgentState,
  RawAgentDecision,
} from "./types";

/**
 * The two decision layers (Phase 6, section 4):
 *
 *   1. `mockAgentPolicy` — the OFFLINE determininstic policy. It implements the
 *      DOCUMENTED branching rules over observable state (weather-needed?,
 *      preferences-needed?, candidates present?, did validation fail?).
 *      With `AI_PROVIDER=mock` the run stays fully deterministic and the
 *      evaluation golden set can pin exact tool trajectories. It is NOT a
 *      hardcoded A→B→C sequence: every branch is state-driven and case-driven.
 *
 *   2. `createLlmDecisionProvider` — the HOSTED lane. The real model observes
 *      a sanitized structured snapshot of the state and returns one
 *      `{action, arguments}` decision (still zod-allowlist-validated centrally
 *      by the runner). This is where genuinely novel trajectories come from.
 *
 * Provider failures THROW (AIProviderError) so the runner can classify the
 * run as `tool-unavailable` per termination rule 5 — never an invalid loop.
 */

// ── Deterministic policy (mock / offline / evaluation) ────────────────────────

export const mockAgentPolicy = (state: AgentState): RawAgentDecision => {
  const t = state.userRequest.toLowerCase();

  const weatherNeeded =
    !state.weather &&
    /\btoday\b|weather|temperature|(what should i wear)|(wear.*(today|now|out)|outdoor|outside|hot|cold|rain|humid|今天|天气|穿什么|下雨|出门|穿.*今天)/.test(t);

  const prefsNeeded =
    !state.preferences &&
    /for me|\bmy (style|taste|preferences?)\b|personal preference|适合我|我的风格|我的喜好|按我的/.test(t);

  // 1. External context first — ONLY when the request actually warrants it.
  if (weatherNeeded) return { action: "get_weather", arguments: {} };
  if (prefsNeeded) return { action: "get_user_preferences", arguments: {} };

  // 2. First search.
  if (!state.candidates) return { action: "search_wardrobe", arguments: {} };

  // 3. Zero candidates — HARD constraints are never relaxed: retry once with
  //    the same hard set (soft query may broaden implicitly), then give up.
  if (state.candidates.length === 0) {
    if (state.searchAttempts < 2) {
      return { action: "search_wardrobe", arguments: {} };
    }
    return {
      action: "finish",
      arguments: { status: "unsatisfiable", message: "no wardrobe items match the frozen hard constraints" },
    };
  }

  // 4. Compose, then validate.
  if (!state.generated) return { action: "generate_outfit", arguments: {} };
  if (!state.validation) return { action: "validate_outfit", arguments: {} };

  // 5. Verdicts.
  if (state.validation.passed) {
    return {
      action: "finish",
      arguments: { status: "success", message: "grounded look passed deterministic + advisory validation" },
    };
  }

  // 6. Validation failure → one more attempt with alternative candidates
  //    (same hard constraints; the search tool merges, never relaxes).
  if (state.searchAttempts < 2) {
    return { action: "search_wardrobe", arguments: {} };
  }
  return {
    action: "finish",
    arguments: { status: "no-valid", message: "no valid look could be composed within the hard constraints" },
  };
};

export const mockAgentDecisionProvider: AgentDecisionProvider = (state) => Promise.resolve(mockAgentPolicy(state));

// ── Hosted LLM decision layer ────────────────────────────────────────────────

export interface LlmDecisionResult {
  decision: RawAgentDecision;
  attempts: number;
  usage: TokenUsage | null;
  model: string;
}

/**
 * One decision via the provider's chat-completion seam. Structured output is
 * achieved by PROMPT + zod validation (the provider returns text; parsing and
 * allowlist-validation are the runner's job). Throws AIProviderError on
 * transport failure; returns a malformed decision (unvalidated) on bad JSON.
 */
export async function requestLlmDecision(
  provider: AIProvider,
  state: AgentState,
): Promise<LlmDecisionResult> {
  const request = { system: buildDecisionSystemPrompt(), user: buildDecisionUserText(state) };
  const result = await provider.complete(request);
  const json = extractJsonObject(result.text);
  return {
    decision: json as RawAgentDecision,
    attempts: 1,
    usage: result.meta.usage ?? null,
    model: result.meta.model,
  };
}

/**
 * The HOSTED decision lane: wraps `requestLlmDecision` in an AgentDecisionProvider,
 * forwarding token usage through the runner-supplied callback (so one run's
 * telemetry aggregates every decision call). Still returns an UNVALIDATED
 * decision — the runner's zod allowlist check remains authoritative.
 */
export function createLlmDecisionProvider(): AgentDecisionProvider {
  return async (state, ctx) => {
    const res = await requestLlmDecision(ctx.provider, state);
    if (res.usage) ctx.onUsage?.(res.usage);
    if (res.model) ctx.onModel?.(res.model);
    return res.decision;
  };
}

export { AIProviderError, AGENT_DECISION_SCHEMA_VERSION };
export type { AgentDecisionContext, AgentDecisionProvider };