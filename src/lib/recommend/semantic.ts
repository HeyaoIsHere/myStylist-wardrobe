import { AIProviderError, type AIProvider, type AICallMeta, type TokenUsage } from "../ai/provider";
import { extractJsonObject } from "../metadata/service";
import type { ClothingAttributes } from "../metadata/schema";
import {
  buildValidationSystemPrompt,
  buildValidationUserText,
  OUTFIT_VALIDATION_SCHEMA_VERSION,
} from "./prompt";
import {
  canonicalizeValidationOutput,
  outfitValidationRawSchema,
  type OutfitValidationRaw,
} from "./schemas";
import type { OutfitItemView, OutfitQuery, QueryValidationResult, SemanticValidation, SemanticValidationCheck } from "./types";

/**
 * The SEMANTIC (LLM) validation lane (Phase 4, ADR D-23).
 *
 * A BOUNDED call — one attempt, one transient retry (same discipline as
 * query understanding); no loop, no tool use, no autonomy. It reviews an
 * already-grounding-tested outfit on four aesthetic dimensions (style
 * coherence, colour harmony, occasion appropriateness, silhouette
 * compatibility) and returns ONLY `passed` / `score` / `issues` / `checks`,
 * validated with zod and canonicalized. It can ADD a failure — style review
 * rejects the look — but can never approve one the deterministic lane rejected
 * (the pipeline simply does not call it when the hard guards fail).
 *
 * Fail-safe: on provider trouble or unparseable output it returns a shaped
 * `run:false`/`run:true, passed:null` record so the deterministic verdict is
 * preserved and the pipeline never throws.
 */

const MAX_ATTEMPTS = 2;

export interface SemanticValidateInput {
  items: OutfitItemView[];
  query: OutfitQuery;
  provider: AIProvider;
  getAttrs: (id: string) => ClothingAttributes | null;
}

function unusable(reason: string, partial: Partial<SemanticValidation> = {}): SemanticValidation {
  return {
    run: false,
    passed: null,
    score: null,
    validationResult: "none" as QueryValidationResult,
    checks: [] as SemanticValidationCheck[],
    issues: [],
    provider: null,
    model: null,
    schemaVersion: null,
    llmAttempts: 0,
    llmRetries: 0,
    usage: null,
    errorCategory: null,
    skipReason: reason,
    ...partial,
  };
}

export function skippedSemanticValidation(reason: string): SemanticValidation {
  return unusable(reason);
}

export async function semanticValidateOutfit(input: SemanticValidateInput): Promise<SemanticValidation> {
  const { items, query, provider, getAttrs } = input;

  const request = {
    system: buildValidationSystemPrompt(),
    user: buildValidationUserText({ items, query, getAttrs, raw: query.raw }),
  };

  let llmAttempts = 0;
  let llmRetries = 0;
  let errorCategory: SemanticValidation["errorCategory"] = null;
  let text: string | null = null;
  let lastMeta: AICallMeta | null = null;

  for (let attempt = 0; ; attempt++) {
    llmAttempts += 1;
    if (attempt > 0) llmRetries += 1;
    try {
      const result = await provider.complete(request);
      text = result.text;
      lastMeta = result.meta;
      break;
    } catch (err) {
      errorCategory = err instanceof AIProviderError ? err.category : "unknown";
      if (errorCategory === "validation" || errorCategory === "config") break;
      if (attempt >= MAX_ATTEMPTS - 1) break;
    }
  }

  const base = {
    llmAttempts,
    llmRetries,
    usage: (lastMeta?.usage ?? null) as TokenUsage | null,
    errorCategory,
  };

  if (text === null) {
    return unusable("semantic review unavailable", { ...base, run: false, errorCategory });
  }

  const json = extractJsonObject(text);
  const parsed = outfitValidationRawSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ...unusable("semantic review unusable", {
        ...base,
        run: true,
        validationResult: "invalid" as QueryValidationResult,
        provider: lastMeta?.provider ?? "n/a",
        model: lastMeta?.model ?? "n/a",
        schemaVersion: OUTFIT_VALIDATION_SCHEMA_VERSION,
      }),
    };
  }

  const state = { coerced: false };
  const v = canonicalizeValidationOutput(parsed.data as OutfitValidationRaw, state);

  return {
    run: true,
    passed: v.passed,
    score: v.score,
    validationResult: state.coerced ? "coerced" : "ok",
    checks: v.checks,
    issues: v.issues,
    provider: lastMeta?.provider ?? "n/a",
    model: lastMeta?.model ?? "n/a",
    schemaVersion: OUTFIT_VALIDATION_SCHEMA_VERSION,
    llmAttempts,
    llmRetries,
    usage: lastMeta?.usage ?? null,
    errorCategory: null,
    skipReason: null,
  };
}