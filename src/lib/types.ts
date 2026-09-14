/** Shared domain types for myStylist.
 *  A pure digital wardrobe + sticker board. No style quiz, no wear logs,
 *  no weather-driven composition. */

export type Lang = "en" | "zh";

export type Category =
  | "tops" | "bottoms" | "dresses" | "outerwear"
  | "shoes" | "bags" | "accessories" | "others";

export interface Localized {
  en: string;
  zh: string;
}

export interface WardrobeItem {
  id: string;
  /** matches an entry in assets-manifest (photo or SVG illustration) */
  stem: string;
  /** uploaded cutout — transparent PNG: data URL (legacy) or /uploads/… URL */
  image?: string | null;
  category: Category;
  /** single name — the language is whatever the user typed */
  name: string;
  addedAt: string; // ISO date
  liked: boolean;
}

/** One sticker placed on the creative board. */
export interface BoardSticker {
  id: string; // wardrobe item id
  x: number; // centre position, fraction of board size
  y: number;
  src: string; // transparent PNG data URL
  scale?: number; // 1 = default size
  /** rotation in degrees — 0 = upright */
  rotation?: number;
}

/** A saved look: a saved sticker board. */
export interface OutfitRecord {
  id: string;
  createdAt: string;
  title: Localized;
  itemIds: string[];
  /** sticker layout of the board */
  stickers?: BoardSticker[];
  saved: boolean;
  liked: boolean | null;
  disliked: boolean;
}

export interface Store {
  /** bumped when the seed shape changes — old stores get migrated/reseeded */
  seedVersion: number;
  wardrobe: WardrobeItem[];
  outfits: OutfitRecord[];
  /** item ids the user has liked / disliked (feedback memory) */
  likedItemIds: string[];
  dislikedItemIds: string[];
}
