import { getAIProvider } from "../ai/providers/index";
import { getMetadata } from "../metadata/store";
import { getStore } from "../db/store";
import { getEmbeddingProvider } from "../retrieval/embedding";
import { FlatFileVectorStore } from "../retrieval/vectorstore";
import { sha256 } from "../retrieval/search";
import { logRecommendation } from "../telemetry";
import { composeOutfit } from "./compose";
import { retrieveForOutfit } from "./retrieve";
import { semanticValidateOutfit, skippedSemanticValidation } from "./semantic";
import { understandQuery } from "./understand";
import { combineValidation, validateOutfitDeterministic } from "./validate";
import { OUTFIT_QUERY_SCHEMA_VERSION } from "./prompt";
import type { OutfitRecommendation, OutfitValidation, RecommendDeps } from "./types";

/**
 * The recommendation workflow (Phase 3 + Phase 4 validation). A DETERMINISTIC
 * linear pipeline — NOT an agent: no tool-selection, no autonomous branching,
 * no loop over model calls. Each stage is fail-safe and has a deterministic
 * fallback, so the workflow ALWAYS completes with a shaped, grounded result.
 *
 *   understand (LLM + deterministic merge) → retrieve (existing lane) → compose
 *   → deterministic validation → semantic validation → PASS / FAIL → result.
 *
 * The validation stage (ADR D-23) is two-lane: deterministic hard guards run
 * first and are ABSOLUTE (they override any LLM verdict); the semantic lane is
 * an advisory LLM review that is simply not called when the hard guards fail.
 *
 * FAIL-SAFE CONTRACT: `recommend` never throws. On provider / retrieval /
 * compose / validation trouble it returns a shaped recommendation with `ok:false`
 * and the reason in `reason`, so a route can always serialize it safely.
 */

/** Default wiring for production: env-selected provider + embeddings + flat-file store. */
export function defaultRecommendDeps(): RecommendDeps {
  return {
    provider: getAIProvider(),
    emb: getEmbeddingProvider(),
    store: new FlatFileVectorStore(),
    getItem: (id) => {
      const item = getStore().wardrobe.find((w) => w.id === id);
      return item ? { id: item.id, name: item.name, category: item.category } : null;
    },
    getAttrs: (id) => getMetadata(id)?.aiGenerated ?? null,
    getCatalog: () => getStore().wardrobe.map((w) => w.id),
  };
}

export async function recommend(raw: string, deps?: RecommendDeps): Promise<OutfitRecommendation> {
  const active = deps ?? defaultRecommendDeps();
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const text = raw.trim();

  const understanding = await understandQuery(text, active.provider);
  const retrieval = await retrieveForOutfit(understanding.query, active);
  const composed = composeOutfit({
    query: understanding.query,
    hits: retrieval.hits,
    getItem: active.getItem,
  });

  // Validation stage (Phase 4): deterministic hard guards run ALWAYS and are
  // absolute; the semantic LLM review only runs on a look that survived them.
  const wardrobeIds = new Set(active.getCatalog());
  const deterministic = validateOutfitDeterministic({
    requested: composed.items,
    constraints: understanding.query.hard,
    wardrobeIds,
    getItem: active.getItem,
    getAttrs: active.getAttrs,
  });
  const semantic =
    composed.ok && deterministic.passed
      ? await semanticValidateOutfit({
          items: composed.items,
          query: understanding.query,
          provider: active.provider,
          getAttrs: active.getAttrs,
        })
      : skippedSemanticValidation(
          composed.ok ? "skipped: deterministic validation failed" : "skipped: no look to validate",
        );
  const validation: OutfitValidation = combineValidation(deterministic, semantic);

  const errorCategory = understanding.errorCategory ?? retrieval.meta.errorCategory ?? null;
  // `retrieval.meta.degraded` marks a lane-wide failure worth surfacing even when a
  // look was composed; validation.passed is the Phase-4 gate on top of compose ok.
  const ok = composed.ok && !retrieval.meta.degraded && validation.passed;
  const meta = {
    requestId,
    parsedBy: understanding.query.parsedBy,
    validationResult: understanding.validationResult,
    provider: understanding.providerMeta?.provider ?? "deterministic",
    model: understanding.providerMeta?.model ?? "n/a",
    schemaVersion: OUTFIT_QUERY_SCHEMA_VERSION,
    latencyMs: Date.now() - started,
    llmAttempts: understanding.llmAttempts,
    llmRetries: understanding.llmRetries,
    usage: understanding.usage,
    retrievalDegraded: retrieval.meta.degraded,
    retrievalModel: retrieval.meta.embeddingModel,
    candidateCount: retrieval.meta.candidateCount,
    indexedCount: retrieval.meta.indexedCount,
    itemCount: composed.items.length,
    grounded: composed.items.length >= 2,
    errorCategory,
    validationPassed: validation.passed,
    semanticRun: validation.semantic.run,
    semanticPassed: validation.semantic.passed,
    semanticScore: validation.semantic.score,
    semanticValidationResult: validation.semantic.validationResult,
  };

  logRecommendation({
    kind: "recommendation",
    requestId,
    queryHash: sha256(text).slice(0, 16),
    parsedBy: meta.parsedBy,
    validationResult: meta.validationResult,
    provider: meta.provider,
    model: meta.model,
    schemaVersion: meta.schemaVersion,
    latencyMs: meta.latencyMs,
    llmAttempts: meta.llmAttempts,
    llmRetries: meta.llmRetries,
    usage: meta.usage,
    grounded: meta.grounded,
    itemCount: meta.itemCount,
    candidateCount: meta.candidateCount,
    retrievalDegraded: meta.retrievalDegraded,
    success: ok && meta.errorCategory === null,
    errorCategory: meta.errorCategory,
    validationPassed: meta.validationPassed,
    semanticRun: meta.semanticRun,
    semanticPassed: meta.semanticPassed,
    semanticScore: meta.semanticScore,
    semanticValidationResult: meta.semanticValidationResult,
    validationErrorCategory: validation.semantic.errorCategory,
  });

  return {
    ok,
    // A failed run with no pieces has no look to title.
    title: ok ? buildTitle(understanding.query) : "No recommendation",
    reason: buildReason(composed.reason, ok || !composed.ok, validation),
    items: composed.items,
    query: understanding.query,
    retrieval,
    validation,
    meta,
  };
}

/** Keep the compose reason unless validation — and nothing else — rejected the look. */
function buildReason(composeReason: string, useComposeReason: boolean, validation: OutfitValidation): string {
  if (useComposeReason) return composeReason;
  const failed = validation.deterministic.checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return `This look was rejected by validation: ${failed.map((c) => c.label).join("; ")}.`;
  }
  const firstIssue = validation.semantic.issues[0];
  return firstIssue
    ? `This look passed the hard checks but not style review: ${firstIssue}`
    : "This look did not pass validation.";
}

function buildTitle(query: { hard: { seasons?: string[] }; context: { occasion?: string } }): string {
  const season = query.hard.seasons?.[0];
  const occasion = query.context.occasion?.trim();
  const bits = [season && capitalize(season), occasion && capitalize(occasion)].filter(Boolean) as string[];
  const head = bits.length > 0 ? bits.join(" ") : "Everyday";
  // A zh head stands alone; only latin heads get the " look" suffix.
  return /[一-鿿]/.test(head) ? head : `${head} look`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return /^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;
}