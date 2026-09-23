import { getAIProvider } from "../ai/providers/index";
import { getMetadata } from "../metadata/store";
import { getStore } from "../db/store";
import { getEmbeddingProvider } from "../retrieval/embedding";
import { FlatFileVectorStore } from "../retrieval/vectorstore";
import {
  createLlmDecisionProvider,
  mockAgentDecisionProvider,
} from "./decide";
import { runAgent, DEFAULT_MAX_ITERATIONS, DEFAULT_TIMEOUT_MS } from "./runner";
import { MockWeatherProvider } from "./weather";
import { defaultPreferencesProvider } from "./prefs";
import type { AgentDeps, AgentResult, AgentRunConfig } from "./types";

/**
 * Phase 6 public API — the bounded Outfit Planner Agent.
 *
 *   defaultAgentDeps()   production wiring (env-selected decision layer)
 *   runAgent(raw, deps)  one bounded run
 *
 * The decision layer is chosen from the SAME env singleton the rest of the app
 * uses: `AI_PROVIDER=mock` → deterministic offline policy (evaluations,
 * local-dev, golden set); `AI_PROVIDER=deepseek` → hosted LLM decision-making.
 * Everything else (weather, preferences, retrieval, composition, validation)
 * is the same seam-based wiring the deterministic workflow already uses.
 */
export { runAgent, mockAgentDecisionProvider, createLlmDecisionProvider, DEFAULT_MAX_ITERATIONS, DEFAULT_TIMEOUT_MS };
export type { AgentDeps, AgentResult, AgentRunConfig };

/** Production wiring for one agent run, matching `defaultRecommendDeps`. */
export function defaultAgentDeps(): AgentDeps {
  const provider = getAIProvider();
  return {
    provider,
    emb: getEmbeddingProvider(),
    store: new FlatFileVectorStore(),
    getItem: (id) => {
      const item = getStore().wardrobe.find((w) => w.id === id);
      return item ? { id: item.id, name: item.name, category: item.category } : null;
    },
    getAttrs: (id) => getMetadata(id)?.aiGenerated ?? null,
    getCatalog: () => getStore().wardrobe.map((w) => w.id),
    weather: new MockWeatherProvider(),
    preferences: defaultPreferencesProvider(),
    decide: provider.name === "mock" ? mockAgentDecisionProvider : createLlmDecisionProvider(),
  };
}