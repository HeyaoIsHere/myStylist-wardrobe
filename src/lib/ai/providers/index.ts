import { AIProvider } from "../provider";
import { mockProvider } from "./mock";
import { createDeepSeekProvider } from "./deepseek";

/**
 * Environment-driven provider selection.
 *
 *   AI_PROVIDER=mock      → deterministic, offline, no keys (default)
 *   AI_PROVIDER=deepseek  → OpenAI-compatible DeepSeek endpoint
 *
 * Selecting is the ONLY place the app maps "the provider I want" to a concrete
 * implementation. Everything downstream uses the `AIProvider` interface.
 */
export function getAIProvider(): AIProvider {
  const kind = (process.env.AI_PROVIDER ?? "mock").trim().toLowerCase();
  if (kind === "deepseek") {
    return createDeepSeekProvider();
  }
  // Unknown / unset values degrade to the offline mock so the app never breaks.
  return mockProvider;
}