import { COLOR_HEX } from "../colorHex";

/**
 * Controlled vocabularies + canonicalization for clothing metadata.
 *
 * Only `seasons`, `formality` and `weatherSuitability` are strictly closed
 * enums. Open-ish fields (material, pattern, fit, styleTags, occasions,
 * subcategory) are canonicalized via synonyms and kept as bounded free tokens —
 * strict enumeration would just drop novel-but-correct model output.
 */

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export const FORMALITY = ["casual", "smart-casual", "business", "business-formal", "formal"] as const;
export type Formality = (typeof FORMALITY)[number];

export const WEATHER = ["cold", "cool", "mild", "warm", "hot"] as const;
export type Weather = (typeof WEATHER)[number];

export const PATTERN_SYNONYMS: Record<string, string> = {
  checkered: "checked",
  check: "checked",
  plain: "solid",
  "graphic print": "graphic",
  "polka dots": "polka-dot",
};

export const FIT_SYNONYMS: Record<string, string> = {
  "slim fit": "slim",
  "slim-fit": "slim",
  "loop-fit": "regular",
  oversize: "oversized",
  "a-line": "a-line",
  flared: "flared",
  "fitted": "fitted",
};

export const STYLE_SYNONYMS: Record<string, string> = {
  minimal: "minimalist",
  casual: "casual",
  street: "streetwear",
};

/** The known palette names (from src/lib/colorHex.ts) used for harmony later. */
export const PALETTE_COLORS: string[] = Object.keys(COLOR_HEX);

/** Lowercase a single token, trim it, collapse inner whitespace, bound length. */
export function normalizeToken(raw: unknown, maxLen = 40): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.toLowerCase().trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.slice(0, maxLen);
}

export interface CanonicListOptions {
  synonyms?: Record<string, string>;
  /** If provided, tokens not in this set are dropped (closed domain). */
  allowed?: readonly string[];
  max?: number;
}

function markCoerced(state: { coerced: boolean }): void {
  state.coerced = true;
}

/** Canonicalize a list of unknown tokens → bounded, deduped canonical tokens. */
export function canonicalizeList(values: unknown, opts: CanonicListOptions, state: { coerced: boolean }): string[] {
  if (!Array.isArray(values)) {
    if (values !== undefined && values !== null) markCoerced(state);
    return [];
  }
  const out: string[] = [];
  for (const raw of values) {
    const token = normalizeToken(raw);
    if (!token) {
      markCoerced(state);
      continue;
    }
    const alias = opts.synonyms?.[token] ?? token;
    const final = opts.allowed && !opts.allowed.includes(alias) ? null : alias;
    if (!final) {
      markCoerced(state);
      continue;
    }
    if (!out.includes(final)) out.push(final);
  }
  if (opts.max && out.length > opts.max) {
    markCoerced(state);
    out.length = opts.max;
  }
  return out;
}

interface CanonicalColor {
  name: string;
  hex?: string;
}

/** A raw model color record → a validated canonical color, or null if unusable. */
export function canonicalColor(raw: unknown, state: { coerced: boolean }): CanonicalColor | null {
  if (typeof raw !== "object" || raw === null) {
    markCoerced(state);
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const name = normalizeToken(rec.name, 30);
  if (!name) {
    markCoerced(state);
    return null;
  }
  const hex = typeof rec.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(rec.hex)
    ? rec.hex.toLowerCase()
    : undefined;
  if (rec.hex !== undefined && hex === undefined) markCoerced(state);
  return { name, ...(hex ? { hex } : {}) };
}

/** Canonicalize a single optional value (fit / subcategory / formality). */
export function canonicalSingle(raw: unknown, opts: { synonyms?: Record<string, string>; allowed?: readonly string[] }, state: { coerced: boolean }): string | null {
  const token = normalizeToken(raw, 40);
  if (!token) return null;
  const alias = opts.synonyms?.[token] ?? token;
  if (opts.allowed && !opts.allowed.includes(alias)) {
    markCoerced(state);
    return null;
  }
  return alias;
}