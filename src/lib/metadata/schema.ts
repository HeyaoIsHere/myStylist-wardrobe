import { z } from "zod";
import type { AIErrorCategory } from "../ai/provider";
import type { Category } from "../types";
import {
  FIT_SYNONYMS,
  FORMALITY,
  PALETTE_COLORS,
  PATTERN_SYNONYMS,
  SEASONS,
  STYLE_SYNONYMS,
  WEATHER,
  canonicalColor,
  canonicalizeList,
  canonicalSingle,
  type Season,
  type Formality,
  type Weather,
} from "./vocab";

/**
 * Structured clothing metadata schema (ADR D-13).
 *
 * Separation of concerns enforced by the record shape:
 *   · userProvided  – what the user typed / chose at upload (authoritative)
 *   · aiGenerated   – model-derived attributes for retrieval & recommendation
 *   · system        – provenance (provider/model/version/confidence) + quality
 *                     signals kept APART from user-facing metadata (D-07 req.)
 *
 * Field choices (dropped/merged — see IMPLEMENTATION_LOG §3):
 *   - `category`     → NOT AI-generated: the user already selects it at upload;
 *                      it is authoritative and lives in `userProvided`.
 *   - `silhouette`   → merged into `fit`, because fit-and-silhouette overlap
 *                      heavily; enumerating both adds retrieval noise.
 *   - kept: subcategory, colors, material, pattern, fit, styleTags, seasons,
 *           occasions, formality, weatherSuitability.
 */

export const METADATA_SCHEMA_VERSION = "clothing-v1";

// ── Schema validation ──────────────────────────────────────────────────────
// Two layers (ADR D-15):
//   1. `rawSchema`  – STRUCTURAL validation only (zod). Catastrophic shapes
//                     (non-string, wrong types, non-array) fail here.
//   2. `canonicalizeAttributes` – policy pass. Enum membership, synonyms,
//                     bounds, dedupe. Produces the canonical `ClothingAttributes`,
//                     which is valid by construction.
// This means a small hallucination (one bad season enum) is salvaged ("coerced"),
// while a structurally broken response degrades safely without touching data.

export const clothingAttributesRawSchema = z.object({
  subcategory: z.unknown().nullish(),
  colors: z.array(z.object({ name: z.string(), hex: z.string().optional() })).optional(),
  material: z.array(z.string()).optional(),
  pattern: z.array(z.string()).optional(),
  fit: z.unknown().nullish(),
  styleTags: z.array(z.string()).optional(),
  seasons: z.array(z.string()).optional(),
  occasions: z.array(z.string()).optional(),
  formality: z.unknown().nullish(),
  weatherSuitability: z.array(z.string()).optional(),
});

export type ClothingAttributesRaw = z.infer<typeof clothingAttributesRawSchema>;

// ── Canonical model ────────────────────────────────────────────────────────
export interface ClothingColor {
  name: string;
  hex?: string;
}

/** Deterministic, bounded, canonical form of AI clothing attributes. */
export interface ClothingAttributes {
  subcategory: string | null;
  colors: ClothingColor[];
  material: string[];
  pattern: string[];
  fit: string | null;
  styleTags: string[];
  seasons: Season[];
  occasions: string[];
  formality: Formality | null;
  weatherSuitability: Weather[];
}

export interface CanonicalizationResult {
  attrs: ClothingAttributes;
  /** true when any token was substituted, dropped, or truncated by policy. */
  coerced: boolean;
}

export function canonicalizeAttributes(raw: ClothingAttributesRaw): CanonicalizationResult {
  const state = { coerced: false };

  const colors: ClothingColor[] = [];
  if (Array.isArray(raw.colors)) {
    for (const c of raw.colors.slice(0, 6)) {
      const color = canonicalColor(c, state);
      if (color && !colors.some((x) => x.name === color.name)) colors.push(color);
    }
    if (raw.colors.length > 6) state.coerced = true;
  }

  const attrs: ClothingAttributes = {
    subcategory: canonicalSingle(raw.subcategory, {}, state),
    colors,
    material: canonicalizeList(raw.material, { max: 6 }, state),
    pattern: canonicalizeList(raw.pattern, { synonyms: PATTERN_SYNONYMS, max: 4 }, state),
    fit: canonicalSingle(raw.fit, { synonyms: FIT_SYNONYMS }, state),
    styleTags: canonicalizeList(raw.styleTags, { synonyms: STYLE_SYNONYMS, max: 8 }, state),
    seasons: canonicalizeList(raw.seasons, { allowed: SEASONS, max: 4 }, state) as Season[],
    occasions: canonicalizeList(raw.occasions, { max: 6 }, state),
    formality: canonicalSingle(raw.formality, { allowed: FORMALITY }, state) as Formality | null,
    weatherSuitability: canonicalizeList(raw.weatherSuitability, { allowed: WEATHER, max: 5 }, state) as Weather[],
  };

  return { attrs, coerced: state.coerced };
}

/** Any populated attribute group at all? Zero ⇒ nothing useful ⇒ degrade. */
export function hasUsableAttributes(a: ClothingAttributes): boolean {
  return (
    (a.subcategory ?? "").length > 0 ||
    a.colors.length > 0 ||
    a.material.length > 0 ||
    a.pattern.length > 0 ||
    (a.fit ?? "").length > 0 ||
    a.styleTags.length > 0 ||
    a.seasons.length > 0 ||
    a.occasions.length > 0 ||
    a.formality !== null ||
    a.weatherSuitability.length > 0
  );
}

/** Aggregate confidence proxy 0…1: fraction of the 10 groups that are populated. */
export function computeConfidence(a: ClothingAttributes | null): number {
  if (!a) return 0;
  const populated =
    Number(Boolean(a.subcategory)) +
    Number(a.colors.length > 0) +
    Number(a.material.length > 0) +
    Number(a.pattern.length > 0) +
    Number(Boolean(a.fit)) +
    Number(a.styleTags.length > 0) +
    Number(a.seasons.length > 0) +
    Number(a.occasions.length > 0) +
    Number(a.formality !== null) +
    Number(a.weatherSuitability.length > 0);
  return Math.round((populated / 10) * 100) / 100;
}

/** Why the AI output was or wasn't accepted (telemetry + system info). */
export type MetadataValidationResult = "ok" | "coerced" | "threshold" | "invalid" | "none";

export interface MetadataSystemInfo {
  provider: string;
  model: string;
  /** Schema/prompt version the extraction contracted against. */
  version: string;
  /** Aggregate confidence 0…1 (see computeConfidence). */
  confidence: number;
  extractedAt: string; // ISO
  requestId: string;
  /** true ⇒ item was saved but no/metadata-free for AI attributes. */
  degraded: boolean;
  /** total provider attempts (first + retries). */
  attempts: number;
  validationResult: MetadataValidationResult;
  errorCategory: AIErrorCategory | null;
}

/** The persisted record — userProvided + aiGenerated + system keep concerns split. */
export interface ClothingMetadataRecord {
  itemId: string;
  userProvided: { name: string; category: Category };
  aiGenerated: ClothingAttributes | null;
  system: MetadataSystemInfo;
}

/** Shape of data/metadata.json */
export interface MetadataFileShape {
  seedVersion: number;
  entries: Record<string, ClothingMetadataRecord>;
}

/** Palette names exposed for retrieval/harmony — shared vocabulary surface. */
export { PALETTE_COLORS };