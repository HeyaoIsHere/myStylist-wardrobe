import type { AIProvider } from "../ai/provider";
import type { AgentState } from "./types";

/**
 * Prompts for the LLM decision layer (Phase 6).
 *
 * The decision step is a STRUCTURED tool-producing step: the model returns one
 * `{action, arguments}` JSON (validated against `agentDecisionRawSchema`), not
 * natural-language tool calls. The system prompt carries a signature token
 * (AGENT_DECISION_SCHEMA) so future mock/logger seams can detect the contract.
 *
 * The model sees ONLY observable structured state (constraints, candidates,
 * weather, validation outcomes, remaining budget) — never a chain of thought.
 */

export const AGENT_DECISION_SCHEMA_VERSION = "agent-decide-v1";
export const AGENT_DECISION_PROMPT_SIGNATURE = "AGENT_DECISION_SCHEMA";

const TOOL_DESCRIPTIONS = `Allowed tools — DECIDE DYNAMICALLY from the current state; never a fixed sequence:
- get_weather {"location"?}  — fetch current weather ONLY when the request actually needs weather context (today / weather / outdoors / temperature).
- get_user_preferences {}    — ONLY when the request asks for personal preference ("for me", "my style", "my taste"). Never otherwise.
- search_wardrobe {"query"?, "constraints"?}  — retrieve real wardrobe items. "constraints" ADD to the frozen hard set (they never remove). Reuse for alternative candidate searches.
- generate_outfit {"itemIds"?}  — compose a look from the candidate item ids a previous search returned. A subset is allowed; ids not in the candidate set are dropped automatically. Never invent ids.
- validate_outfit {"itemIds", "context"?}  — run deterministic hard-guard validation (authoritative) plus advisory style review on a candidate look.
- finish {"status": "success"|"no-valid"|"unsatisfiable", "message"?, "itemIds"?}  — end the run with a grounded final answer.`;

const POLICY_RULES = `Policy:
- HARD constraints (state.hard) must NEVER be relaxed; a search may only ADD constraints. If a request cannot be satisfied, finish with status "unsatisfiable" rather than dropping a constraint.
- SOFT preferences (state.soft) may be broadened on retry.
- On zero candidates: do NOT relax hard constraints — either retry with a softer query text or finish(status:"unsatisfiable").
- On validation failure: you may search again / regenerate once, then finish(status:"no-valid") if it still fails.
- Never call get_weather or get_user_preferences when the request does not warrant it.
- Never emit a clothing id that is not in the presented candidate/generated lists.
- Every run terminates by budget (max iterations) or deadline — stay under it.
- If a grounded outfit passed deterministic validation, finish(status:"success") and optionally name its itemIds.`;

export function buildDecisionSystemPrompt(): string {
  return [
    `You are the myStylist outfit-planner agent decision step. ${AGENT_DECISION_PROMPT_SIGNATURE}`,
    "You observe the state of an outfit-planning run and choose EXACTLY ONE next tool. Return ONLY the JSON object {\"action\": \"...\", \"arguments\": {...}} — no prose, no code fences, no markdown.",
    TOOL_DESCRIPTIONS,
    POLICY_RULES,
  ].join("\n");
}

export function buildDecisionUserText(state: AgentState): string {
  const snapshot = {
    request: state.userRequest.slice(0, 200),
    hard: state.hard,
    soft: state.soft,
    weather: state.weather
      ? { condition: state.weather.condition, temperatureC: state.weather.temperatureC }
      : null,
    preferences: state.preferences ? { styleSignals: state.preferences.styleSignals, source: state.preferences.source } : null,
    candidates: state.candidates?.slice(0, 20).map((c) => ({ itemId: c.itemId, score: Number(c.score.toFixed(4)) })) ?? null,
    generated: state.generated?.map((v) => v.id) ?? null,
    lastValidation: state.validation
      ? {
          passed: state.validation.passed,
          detPassed: state.validation.deterministic.passed,
          failedGuards: state.validation.deterministic.checks.filter((c) => !c.passed).map((c) => c.id),
          semPassed: state.validation.semantic.passed,
          score: state.validation.score,
        }
      : null,
    searchAttempts: state.searchAttempts,
    iterationDone: state.iteration,
    trace: state.trace.map((t) => ({ tool: t.tool, success: t.success, summary: t.summary })),
  };
  return `Current run state (structured, observable — no hidden reasoning):\n${JSON.stringify(snapshot, null, 2)}\n\nReturn the next tool decision JSON.`;
}

/** Detects an LLM decision provider usable with a given AI provider (for wiring). */
export function isLlmDecisionCapable(provider: AIProvider): boolean {
  return provider.name !== "mock";
}