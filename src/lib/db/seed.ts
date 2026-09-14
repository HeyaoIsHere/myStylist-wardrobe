import type { Store } from "@/lib/types";

/**
 * The wardrobe starts EMPTY — the user fills it with their own clothes.
 */
export function buildSeed(): Store {
  return {
    seedVersion: 6,
    wardrobe: [],
    outfits: [],
    likedItemIds: [],
    dislikedItemIds: [],
  };
}
