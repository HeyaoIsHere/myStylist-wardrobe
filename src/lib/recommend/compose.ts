import type { Category } from "../types";
import type { OutfitItemView, OutfitQuery, OutfitRole } from "./types";

/**
 * Deterministic slot-filling compose (D-06). The ONLY input the item side of
 * this function accepts is `<itemId>` from the retrieval lane — an LLM can
 * never supply an item here, so an invented piece is impossible by construction
 * (grounding rule). Everything is a pure function: same hits, same look.
 */

const ROLE_OF: Record<Category, OutfitRole> = {
  dresses: "dress",
  tops: "top",
  bottoms: "bottom",
  outerwear: "outerwear",
  shoes: "shoes",
  bags: "bag",
  accessories: "accessory",
  others: "other",
};

/** Display order after the core: shoes first, then cover-ups / accents. */
const DISPLAY_ORDER: OutfitRole[] = ["dress", "top", "bottom", "shoes", "outerwear", "bag", "accessory", "other"];

export interface ComposeInput {
  query: OutfitQuery;
  /** id + score only — compose never reads the embedding record, so the agent's
   *  candidate list (which deliberately keeps no vector) is compatible. */
  hits: Array<{ itemId: string; score: number }>;
  getItem: (id: string) => { id: string; name: string; category: Category } | null;
}

export interface ComposeResult {
  ok: boolean;
  reason: string;
  items: OutfitItemView[];
}

export const NOT_ENOUGH_ITEMS =
  "Not enough matching pieces to compose a full look — a look needs a top and bottom (or a dress) plus shoes.";

export const NO_MATCHES =
  "No wardrobe items matched this request. Try softening a hard constraint (color, season, category) or describing it differently.";

export function composeOutfit(input: ComposeInput): ComposeResult {
  const { query, hits, getItem } = input;

  // Assign each retrieved hit to its role one time, best-score first. Hits from
  // items that no longer exist in the catalog (stale vectors) are dropped here.
  const filled = new Map<OutfitRole, OutfitItemView>();
  for (const hit of hits) {
    const item = getItem(hit.itemId);
    if (!item) continue; // ghost vector → skip, never surface
    const role = ROLE_OF[item.category];
    if (filled.has(role)) continue; // one piece per slot; ranked order already
    filled.set(role, {
      id: item.id,
      name: item.name,
      category: item.category,
      role,
      score: Math.round(hit.score * 10000) / 10000,
    });
  }

  // Core of the look, ANCHORED ON THE BEST-SCORING PIECE: a dress leads only
  // when it is the top-ranked candidate; otherwise a top + bottom pair carries
  // the look. Deciding by score (not category priority) keeps the recommendation
  // honest — ask for a "crew neck" and you get the tee, not a lower-ranked dress.
  const dress = filled.get("dress");
  const top = filled.get("top");
  const bottom = filled.get("bottom");
  const dressWins = Boolean(dress) && (top === undefined || dress!.score >= top.score) && (bottom === undefined || dress!.score >= bottom.score);
  let core: OutfitItemView[] = [];
  if (dressWins) {
    core = [dress!];
  } else if (top && bottom) {
    core = [top, bottom];
  }

  if (core.length === 0) {
    const reason = filled.size === 0 ? NO_MATCHES : NOT_ENOUGH_ITEMS;
    return { ok: false, reason, items: [] };
  }

  const items = [...core];
  for (const role of DISPLAY_ORDER) {
    if (role === "dress" || role === "top" || role === "bottom") continue;
    const extra = filled.get(role);
    if (extra && !items.some((i) => i.id === extra.id)) items.push(extra);
  }

  // A single piece is not a look — a dress alone (or a lone top) stays "ok:false".
  if (items.length < 2) {
    return { ok: false, reason: NOT_ENOUGH_ITEMS, items };
  }

  const reason = buildReason(query, items);
  return { ok: true, reason, items };
}

function buildReason(query: OutfitQuery, items: OutfitItemView[]): string {
  const coreText = items.map((i) => i.name).join(" · ");
  const base =
    items.length > 3
      ? `This look pairs ${coreText} and ${items.length - 3} more pieces`
      : `This look pairs ${coreText}`;
  const pin = query.context.note?.trim();
  const occasion = query.context.occasion?.trim();
  const mood = query.context.mood?.trim();
  const flavor = [occasion, mood, pin].filter(Boolean).join(" · ");
  return flavor ? `${base}. All items are drawn from your wardrobe, ranked for "${flavor}".` : `${base}. All items are drawn from your wardrobe and ranked against your request.`;
}