import {
  AIProviderError,
  type AIErrorCategory,
  type AIProvider,
  type AICallMeta,
  type TokenUsage,
} from "../ai/provider";
import { extractJsonObject } from "../metadata/service";
import { buildOutfitSystemPrompt, buildOutfitUserText } from "./prompt";
import { canonicalizeOutfitIntent, outfitQueryRawSchema, type OutfitQueryRaw } from "./schemas";
import { extractDeterministicSuggestions } from "./deterministic";
import type { MetadataConstraints } from "../retrieval/types";
import type { OutfitQuery, ParseOrigin, QueryContext, QueryValidationResult } from "./types";

/**
 * Query understanding (D-06: deterministic-first; LLM enriches, never
 * load-bearing for correctness).
 *
 * Pipeline per run:
 *   1. DETERMINISTIC extractor seeds hard constraints + soft from the raw text
 *      — the guarantees are in place before any model call.
 *   2. LLM lane parses the request into the same shape (with retry for
 *      transient failures), zod-validated + canonicalized.
 *   3. Final query = merge: hard constraints are the UNION of both lanes (each
 *      value is validated against closed enums by construction), so a correct
 *      LLM may add what the extractor missed but can never violate a constraint
 *      the user stated. On LLM failure/invalid output, the seed alone stands.
 *
 * Never throws: on any model trouble the deterministic lane still yields a
 * usable query. `parsedBy` records who actually produced it.
 */

const MAX_ATTEMPTS = 2;

export interface UnderstandOutcome {
  query: OutfitQuery;
  validationResult: QueryValidationResult;
  llmAttempts: number;
  llmRetries: number;
  errorCategory: AIErrorCategory | null;
  providerMeta: { provider: string; model: string; version: string } | null;
  usage: TokenUsage | null;
}

export async function understandQuery(raw: string, provider: AIProvider): Promise<UnderstandOutcome> {
  const text = raw.trim();
  const seed = extractDeterministicSuggestions(text);

  let llmAttempts = 0;
  let llmRetries = 0;
  let errorCategory: AIErrorCategory | null = null;
  let llmText: string | null = null;
  let lastMeta: AICallMeta | null = null;

  // Attempt the LLM lane (retry only transient categories — a config or
  // validation problem won't fix itself). Same attempt/retry accounting as the
  // metadata extraction service.
  const request = { system: buildOutfitSystemPrompt(), user: buildOutfitUserText(text) };
  for (let attempt = 0; ; attempt++) {
    llmAttempts += 1;
    if (attempt > 0) llmRetries += 1;
    try {
      const result = await provider.complete(request);
      llmText = result.text;
      lastMeta = result.meta;
      break;
    } catch (err) {
      errorCategory = err instanceof AIProviderError ? err.category : "unknown";
      if (errorCategory === "validation" || errorCategory === "config") break;
      if (attempt >= MAX_ATTEMPTS - 1) break;
    }
  }

  let parsedBy: ParseOrigin = "deterministic";
  let validationResult: QueryValidationResult = "none";
  let llmHard: MetadataConstraints | null = null;
  const llmSoft: string[] = [];
  let llmContext: QueryContext = {};

  if (llmText !== null) {
    const json = extractJsonObject(llmText);
    const parsed = outfitQueryRawSchema.safeParse(json);
    if (parsed.success) {
      const state = { coerced: false };
      const intent = canonicalizeOutfitIntent(parsed.data as OutfitQueryRaw, state);
      llmHard = intent.hard;
      llmSoft.push(...intent.soft);
      llmContext = intent.context;
      validationResult = state.coerced ? "coerced" : "ok";
      parsedBy = "llm";
    } else {
      validationResult = "invalid";
    }
  }

  const hard = mergeHard(seed.hard, llmHard);
  const soft = dedupe([...seed.soft, ...llmSoft]);

  const query: OutfitQuery = {
    raw: text,
    hard,
    soft,
    context: llmContext,
    parsedBy,
  };

  return {
    query,
    validationResult,
    llmAttempts,
    llmRetries,
    errorCategory,
    providerMeta: lastMeta ? { provider: lastMeta.provider, model: lastMeta.model, version: lastMeta.version } : null,
    usage: lastMeta?.usage ?? null,
  };
}

/** Union of both lanes' constraints. Every value is already enum-validated. */
function mergeHard(seed: MetadataConstraints, llm: MetadataConstraints | null): MetadataConstraints {
  if (!llm) return seed;
  const out: MetadataConstraints = {};
  const uniq = (a?: string[], b?: string[]) => {
    if (!a && !b) return undefined;
    const all = [...(a ?? []), ...(b ?? [])];
    return [...new Set(all)].slice(0, 8);
  };
  out.categories = uniq(seed.categories, llm.categories) as typeof out.categories;
  out.colors = uniq(seed.colors, llm.colors);
  out.seasons = uniq(seed.seasons, llm.seasons) as typeof out.seasons;
  out.occasions = uniq(seed.occasions, llm.occasions);
  // formality is single-valued: the deterministic seed wins on conflict (the
  // guarantee side must stay deterministic).
  out.formality = seed.formality ?? llm.formality ?? undefined;
  for (const k of ["categories", "colors", "seasons", "occasions"] as const) {
    if (!out[k] || out[k]!.length === 0) delete out[k];
  }
  if (!out.formality) delete out.formality;
  return out;
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const t = item.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.slice(0, 8);
}