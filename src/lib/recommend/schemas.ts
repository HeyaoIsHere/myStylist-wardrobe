import { z } from "zod";
import { FORMALITY, SEASONS, normalizeToken } from "../metadata/vocab";
import type { MetadataConstraints } from "../retrieval/types";
import type { QueryContext, SemanticCheckId, SemanticValidationCheck } from "./types";

/**
 * Runtime validation of the LLM's query-understanding output (ADR D-07 layered
 * over the deterministic extractor). Two layers, same pattern as clothing
 * metadata (ADR D-15):
 *   1. `outfitQueryRawSchema` — STRUCTURAL validation (zod). Wrong types,
 *      non-arrays, out-of-domain enums fail here.
 *   2. `canonicalizeOutfitIntent` — policy pass: normalize tokens, dedupe,
 *      bounds. Produces a valid-by-construction `OutfitQuery` fragment.
 *
 * Crucially the schema contains NO item-ID and NO clothing-name fields: the
 * model literally cannot invent wardrobe items (grounding rule).
 */

export const CATEGORY_VALUES = [
  "tops", "bottoms", "dresses", "outerwear", "shoes", "bags", "accessories", "others",
] as const;

export const hardIntentRawSchema = z.object({
  categories: z.array(z.enum(CATEGORY_VALUES)).max(8).optional(),
  colors: z.array(z.string().max(40)).max(8).optional(),
  seasons: z.array(z.enum(SEASONS)).max(4).optional(),
  occasions: z.array(z.string().max(40)).max(6).optional(),
  formality: z.enum(FORMALITY).nullish(),
});
export type HardIntentRaw = z.infer<typeof hardIntentRawSchema>;

export const outfitQueryRawSchema = z.object({
  hard: hardIntentRawSchema.optional(),
  soft: z.array(z.string().max(120)).max(8).optional(),
  context: z
    .object({
      occasion: z.string().max(120).optional(),
      mood: z.string().max(120).optional(),
      note: z.string().max(300).optional(),
    })
    .optional(),
});
export type OutfitQueryRaw = z.infer<typeof outfitQueryRawSchema>;

/** Clean, bounded values produced by the policy pass. */
export interface CanonicalOutfitIntent {
  hard: MetadataConstraints;
  soft: string[];
  context: QueryContext;
}

export function canonicalizeOutfitIntent(raw: OutfitQueryRaw, state: { coerced: boolean }): CanonicalOutfitIntent {
  const hard: MetadataConstraints = {};
  const h = raw.hard;

  if (h?.categories?.length) {
    hard.categories = [...new Set(h.categories)].slice(0, 6);
    if (h.categories.length > 6) state.coerced = true;
  }
  if (h?.colors?.length) {
    const colors: string[] = [];
    for (const rawColor of h.colors) {
      const name = normalizeToken(rawColor, 30);
      if (!name) {
        state.coerced = true;
        continue;
      }
      if (!colors.includes(name)) colors.push(name);
    }
    if (colors.length) hard.colors = colors.slice(0, 8);
    if (h.colors.length > 8) state.coerced = true;
  }
  if (h?.seasons?.length) {
    hard.seasons = [...new Set(h.seasons)].slice(0, 4);
    if (h.seasons.length > 4) state.coerced = true;
  }
  if (h?.occasions?.length) {
    const occasions: string[] = [];
    for (const rawOcc of h.occasions) {
      const o = normalizeToken(rawOcc, 30);
      if (o && !occasions.includes(o)) occasions.push(o);
    }
    if (occasions.length) hard.occasions = occasions.slice(0, 6);
    if (h.occasions.length > 6) state.coerced = true;
  }
  if (h?.formality) {
    hard.formality = h.formality;
  }

  const soft: string[] = [];
  for (const rawSoft of raw.soft ?? []) {
    const s = normalizeToken(rawSoft, 80);
    if (s && !soft.includes(s)) soft.push(s);
  }
  if ((raw.soft?.length ?? 0) > 0 && soft.length < (raw.soft?.length ?? 0)) state.coerced = true;

  const ctx = raw.context ?? {};
  const context: QueryContext = {};
  for (const key of ["occasion", "mood", "note"] as const) {
    const v = ctx[key];
    if (typeof v === "string" && v.trim()) context[key] = v.trim().slice(0, key === "note" ? 300 : 120);
  }

  return { hard, soft: soft.slice(0, 8), context };
}

/** True when a canonical hard-constraint object actually constrains something. */
export function hasHardConstraints(hard: MetadataConstraints): boolean {
  return Boolean(
    hard.categories?.length || hard.colors?.length || hard.seasons?.length || hard.occasions?.length || hard.formality,
  );
}

// ── Outfit validation output (Phase 4) ──────────────────────────────────────
// The validator LLM reviews an ALREADY-GROUNDED outfit (ids supplied by the
// pipeline): this schema carries ONLY the verdict — `passed` / `score` /
// `issues` / `checks`. It deliberately contains NOTHING about specific items
// (no ids, no names to overwrite), so a model slip can add a flag or a note
// but can never change what is recommended (D-23).

export const outfitValidationCheckRawSchema = z.object({
  passed: z.boolean(),
  note: z.string().max(200).optional(),
});

export const outfitValidationRawSchema = z.object({
  passed: z.boolean(),
  score: z.number(),
  issues: z.array(z.string().max(200)).max(10).optional(),
  checks: z
    .object({
      styleCoherence: outfitValidationCheckRawSchema.optional(),
      colorHarmony: outfitValidationCheckRawSchema.optional(),
      occasionAppropriateness: outfitValidationCheckRawSchema.optional(),
      silhouetteCompatibility: outfitValidationCheckRawSchema.optional(),
    })
    .optional(),
});
export type OutfitValidationRaw = z.infer<typeof outfitValidationRawSchema>;

/** Score at/above which the semantic review passes (0–100). */
export const SEMANTIC_PASS_THRESHOLD = 60;

const SEMANTIC_CHECK_KEYS = {
  styleCoherence: "style-coherence",
  colorHarmony: "color-harmony",
  occasionAppropriateness: "occasion-appropriateness",
  silhouetteCompatibility: "silhouette-compatibility",
} as const;

export interface CanonicalValidationOutput {
  passed: boolean;
  /** 0–100, clamped. */
  score: number;
  issues: string[];
  checks: SemanticValidationCheck[];
}

/**
 * Policy pass over a structurally-valid verdict. The SCORE is authoritative:
 * a model `passed` that disagrees with the threshold is overridden (coerced).
 * Missing sub-checks are treated as "not rated" (pass) — the reviewer is
 * advisory, so an uninspected dimension cannot secretly reject a look.
 */
export function canonicalizeValidationOutput(raw: OutfitValidationRaw, state: { coerced: boolean }): CanonicalValidationOutput {
  let score = Math.round(raw.score);
  if (!Number.isFinite(score)) {
    state.coerced = true;
    score = raw.passed ? 80 : 30;
  } else if (score < 0) {
    state.coerced = true;
    score = 0;
  } else if (score > 100) {
    state.coerced = true;
    score = 100;
  }

  const passed = score >= SEMANTIC_PASS_THRESHOLD;
  if (passed !== raw.passed) state.coerced = true;

  const issues: string[] = [];
  if (!Array.isArray(raw.issues)) {
    if (raw.issues !== undefined) state.coerced = true;
  } else {
    for (const issue of raw.issues) {
      const t = normalizeToken(issue, 150);
      if (t && !issues.includes(t)) issues.push(t);
    }
    if (issues.length > 10) {
      state.coerced = true;
      issues.length = 10;
    }
  }

  const rack = raw.checks ?? {};
  const checks: SemanticValidationCheck[] = [];
  for (const [key, id] of Object.entries(SEMANTIC_CHECK_KEYS)) {
    const sub = (rack as Record<string, { passed?: boolean; note?: string } | undefined>)[key];
    if (!sub || typeof sub.passed !== "boolean") {
      state.coerced = true;
      checks.push({ id: id as SemanticCheckId, passed: true, note: "not rated" });
      continue;
    }
    const note = normalizeToken(sub.note, 150) ?? "";
    checks.push({ id: id as SemanticCheckId, passed: sub.passed, note });
  }

  return { passed, score, issues, checks };
}