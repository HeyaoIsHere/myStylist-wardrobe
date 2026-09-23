import { FORMALITY, PALETTE_COLORS, SEASONS, type Season } from "../metadata/vocab";
import type { MetadataConstraints } from "../retrieval/types";
import type { Category } from "../types";

/**
 * Deterministic bilingual query extractor (D-06: deterministic-first).
 *
 * Runs BEFORE the LLM and ALSO replaces it when the LLM lane fails. It pulls
 * HARD constraints straight out of the free text using bounded keyword tables
 * (en + zh), so constraint guarantees never depend on a model. Anything it
 * cannot classify is left to the semantic lane through `soft` = the raw text.
 *
 * Scope limit: keyword matching, not semantics. It finds explicit category /
 * color / season / formality words; fuzzy style (minimalist, quiet luxury) and
 * paraphrase remain the semantic lane's job. Table additions are versioned with
 * the prompt version constant — bump OUTFIT_QUERY_SCHEMA_VERSION when these
 * tables change meaningfully.
 */

/** Latin terms match whole-words (so "top" ≠ "stop"); CJK terms are substrings. */
function hasTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  if (/[一-鿿]/.test(t)) return text.includes(t);
  const escaped = t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(text);
}

export const CATEGORY_TERMS: Array<[string[], Category]> = [
  [["top", "tops", "tee", "tshirt", "t-shirt", "shirt", "blouse", "turtleneck", "pullover", "sweater", "上衣", "上装", "衬衫", "t恤", "毛衣", "短袖"], "tops"],
  [["bottom", "bottoms", "pant", "pants", "trouser", "trousers", "jeans", "skirt", "chinos", "裤子", "长裤", "短裤", "牛仔裤", "半身裙"], "bottoms"],
  [["dress", "dresses", "gown", "连衣裙", "裙子"], "dresses"],
  [["outerwear", "coat", "coats", "jacket", "jackets", "blazer", "parka", "cardigan", "外套", "大衣", "夹克", "开衫", "风衣"], "outerwear"],
  [["shoe", "shoes", "sneaker", "sneakers", "boot", "boots", "loafer", "loafers", "heel", "heels", "鞋", "运动鞋", "靴子", "皮鞋"], "shoes"],
  [["bag", "bags", "handbag", "tote", "backpack", "purse", "包", "手提包", "背包"], "bags"],
  [["accessor", "accessories", "scarf", "hat", "belt", "gloves", "jewelry", "配饰", "围巾", "帽子", "腰带", "手套"], "accessories"],
];

/** Palette names → bilingual surfaces (subset of src/lib/colorHex palette). */
export const COLOR_TERMS: Record<string, string[]> = {
  white: ["white", "白色", "白"],
  black: ["black", "黑色", "黑"],
  cream: ["cream", "米色", "奶白", "奶油色"],
  ivory: ["ivory", "象牙白"],
  oat: ["oat", "燕麦色"],
  blue: ["blue", "蓝色", "蓝"],
  indigo: ["indigo", "靛蓝"],
  grey: ["grey", "gray", "灰色", "灰"],
  olive: ["olive", "橄榄绿"],
  champagne: ["champagne", "香槟色"],
  terracotta: ["terracotta", "陶土色"],
  camel: ["camel", "驼色"],
  beige: ["beige", "米白", "米色"],
  nude: ["nude", "裸色"],
  brown: ["brown", "棕色", "咖啡色"],
  tan: ["tan", "褐色"],
  gold: ["gold", "金色"],
  pearl: ["pearl", "珍珠白"],
  multi: ["multi", "多色"],
};

/** Seasons — closed enum, en + zh. */
export const SEASON_TERMS: Record<string, string[]> = {
  spring: ["spring", "春季", "春天", "春"],
  summer: ["summer", "夏季", "夏天", "夏"],
  autumn: ["autumn", "fall", "秋季", "秋天", "秋"],
  winter: ["winter", "冬季", "冬天", "冬"],
};

/** Formality — closed enum. Specific first so "smart casual" beats "casual". */
export const FORMALITY_PRIORITY: Array<[string, string[]]> = [
  ["business-formal", ["business formal", "商务正式"]],
  ["smart-casual", ["smart casual", "smart-casual", "半正式", "休闲商务"]],
  ["business", ["business", "office", "workwear", "work", "西装", "商务", "通勤"]],
  ["formal", ["formal", "gala", "evening", "正式", "晚宴"]],
  ["casual", ["casual", "休闲", "随性"]],
];

export interface DeterministicSuggestion {
  hard: MetadataConstraints;
  soft: string[];
}

export function extractDeterministicSuggestions(raw: string): DeterministicSuggestion {
  const text = raw.trim();
  const hard: MetadataConstraints = {};

  // Categories — explicit only, union of every matching surface.
  const categories: Category[] = [];
  for (const [terms, category] of CATEGORY_TERMS) {
    if (terms.some((t) => hasTerm(text, t)) && !categories.includes(category)) categories.push(category);
  }
  if (categories.length) hard.categories = categories.slice(0, 6);

  // Colors — palette is closed; drop terms outside it.
  const colors: string[] = [];
  for (const name of PALETTE_COLORS) {
    const terms = COLOR_TERMS[name];
    if (terms?.some((t) => hasTerm(text, t))) colors.push(name);
  }
  if (colors.length) hard.colors = colors.slice(0, 8);

  // Seasons — closed enum, en + zh.
  const seasons: Season[] = [];
  for (const season of SEASONS) {
    if (SEASON_TERMS[season]?.some((t) => hasTerm(text, t))) seasons.push(season);
  }
  if (seasons.length) hard.seasons = seasons.slice(0, 4);

  // Formality — single value; most-specific first.
  for (const [formality, terms] of FORMALITY_PRIORITY) {
    if (terms.some((t) => hasTerm(text, t))) {
      if (FORMALITY.includes(formality as (typeof FORMALITY)[number])) hard.formality = formality;
      break;
    }
  }

  // Soft: everything else the user said IS the ranking signal — the full
  // normalized request rides along so the semantic lane never loses context.
  const soft = text ? [text.slice(0, 400)] : [];
  return { hard, soft };
}