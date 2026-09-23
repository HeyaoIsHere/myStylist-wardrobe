import type { ClothingAttributes } from "../metadata/schema";
import type { Category } from "../types";

/**
 * Canonical text representation for one wardrobe item (ADR D-17 — strategy A:
 * structured metadata converted into text).
 *
 * Design rules:
 *   · Derived from the CURRENT store item (name/category — the user may rename
 *     items via PATCH) joined with the metadata record's AI attributes. Never
 *     depends on `userProvided` alone, so renames re-index correctly without
 *     re-extraction.
 *   · Tokens are deduped, order-stable, single string. The offline hash
 *     embedding treats this as a bag of words afterwards.
 *   · Small bilingual synonym tokens are appended for the CLOSED vocabularies
 *     (seasons, formality, weather, palette colors) and common style
 *     descriptors, so zh query tokens (蓝色 / 夏季) lexically overlap the
 *     representation. Hand-maintained + versioned — a deliberate scope limit:
 *     full multilingual semantics belong to the hosted embedding provider.
 *   · Degraded items (aiGenerated = null) still produce "name + category",
 *     so they remain retrievable; extraction quality only improves the vector.
 */

/** Bump when the representation changes shape — old vectors become content
 *  (not wrong) and reindexAll() regenerates deterministically. */
export const TEXT_REP_VERSION = "textrep-v1";

/** canonical token → extra synonym tokens (zh first, then en aliases). */
const LABELS: Record<string, string[]> = {
  // palette colors (subset of src/lib/colorHex palette names)
  white: ["白色", "white"],
  black: ["黑色"],
  cream: ["米色", "奶白"],
  ivory: ["象牙白"],
  oat: ["燕麦色"],
  blue: ["蓝色", "蓝"],
  indigo: ["靛蓝"],
  grey: ["灰色", "灰"],
  olive: ["橄榄绿"],
  champagne: ["香槟色"],
  terracotta: ["陶土色"],
  camel: ["驼色"],
  beige: ["米白"],
  nude: ["裸色"],
  brown: ["棕色", "咖啡色"],
  tan: ["褐色"],
  straw: ["草色"],
  gold: ["金色"],
  pearl: ["珍珠白"],
  multi: ["多色", "mixed"],
  // seasons — closed enum (metadata/vocab)
  spring: ["春季", "春天", "春"],
  summer: ["夏季", "夏天", "夏"],
  autumn: ["秋季", "秋天", "秋", "fall"],
  winter: ["冬季", "冬天", "冬", "cold season"],
  // formality — closed enum (metadata/vocab)
  casual: ["休闲"],
  "smart-casual": ["半正式", "smart casual"],
  business: ["商务"],
  "business-formal": ["商务正式"],
  formal: ["正式"],
  // weather — closed enum (metadata/vocab)
  cold: ["冷"],
  cool: ["凉"],
  mild: ["温和"],
  warm: ["暖"],
  hot: ["热"],
  // common style descriptors used across canonical style tags
  minimalist: ["极简", "极简主义", "minimal"],
  classic: ["经典"],
  chic: ["时髦", "别致"],
  romantic: ["浪漫"],
  relaxed: ["放松", "随性", "relax"],
  elegant: ["优雅"],
  edgy: ["前卫", "酷"],
  cozy: ["舒适", "温暖居家"],
  bohemian: ["波西米亚", "boho"],
  preppy: ["学院", "预科"],
  street: ["街头", "streetwear", "urban"],
  streetwear: ["街头", "street"],
  statement: ["醒目", "个性"],
  sporty: ["运动"],
  vintage: ["复古", "古着"],
  city: ["都市"],
  lounge: ["居家"],
  tailored: ["修身", "定制感"],
  slim: ["修身"],
  regular: ["常规"],
  oversized: ["宽松"],
  fitted: ["合身"],
  "a-line": ["a字"],
  flared: ["喇叭"],
  // common materials (open field — bounded tokens, help lexical recall)
  cotton: ["棉", "纯棉"],
  linen: ["亚麻"],
  wool: ["羊毛"],
  silk: ["丝绸", "真丝"],
  denim: ["牛仔"],
  leather: ["皮革", "皮"],
  knit: ["针织"],
  polyester: ["涤纶"],
  cashmere: ["羊绒"],
  velvet: ["天鹅绒"],
  chiffon: ["雪纺"],
  // patterns (open field)
  solid: ["纯色", "素色"],
  striped: ["条纹"],
  checked: ["格纹", "格子", "checkered"],
  "polka-dot": ["波点", "圆点", "polka"],
  floral: ["碎花", "花"],
  graphic: ["图案", "印花"],
  plaid: ["苏格兰格"],
  houndstooth: ["千鸟格"],
};

function expand(token: string): string[] {
  return LABELS[token] ?? [];
}

export interface ItemLike {
  id: string;
  name: string;
  category: Category;
}

/** Build the canonical embedding text for one item. Never throws on bad attrs. */
export function buildItemText(item: ItemLike, attrs: ClothingAttributes | null): string {
  const parts: string[] = [];
  const push = (token: string | undefined | null) => {
    if (!token) return;
    const t = token.toLowerCase().trim();
    if (!t) return;
    if (!parts.includes(t)) parts.push(t);
    for (const x of expand(t)) if (x && !parts.includes(x)) parts.push(x);
  };

  // The user's own words + canonical category always present.
  push(item.name);
  push(item.category);
  if (item.category === "outerwear") push("coats jackets");

  if (attrs) {
    push(attrs.subcategory);
    for (const c of attrs.colors) push(c.name);
    for (const m of attrs.material) push(m);
    for (const p of attrs.pattern) push(p);
    push(attrs.fit);
    for (const s of attrs.styleTags) push(s);
    for (const s of attrs.seasons) push(s);
    for (const o of attrs.occasions) push(o);
    push(attrs.formality);
    for (const w of attrs.weatherSuitability) push(w);
  }

  return parts.join(" ");
}

/** The query is embedded as-is (query understanding is a later phase). Kept
 *  id-symmetric with item text so either side can embed with the same provider. */
export function buildQueryText(query: string): string {
  return query.trim();
}