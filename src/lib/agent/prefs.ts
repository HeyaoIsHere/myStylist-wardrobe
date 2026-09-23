import { getStore } from "../db/store";
import type { PreferencesProvider, UserPreferences } from "./types";

/**
 * User-preference provider seam (Phase 6 tool `get_user_preferences`).
 *
 * Honesty rule from the Phase-6 brief: "Do not invent personal preferences."
 * The only grounded source today is the user's REAL like/dislike feedback —
 * `store.json.likedItemIds` / `dislikedItemIds` — which is written by the
 * wardrobe UI but (until Phase-1b personalization) not queried anywhere else.
 * This provider reads it as-is and turns liked items into style signals
 * (style tags + formality from their metadata). No turnover is ever fabricated.
 *
 * The deterministic mock returns EMPTY signals: it exists to exercise the
 * tool-calling path offline without pretending to know the user.
 */

/** Aggregate style signals from the user's actually-liked items (grounded). */
export class StorePreferencesProvider implements PreferencesProvider {
  readonly name = "store-preferences";

  async getPreferences(): Promise<UserPreferences> {
    const store = getStore();
    const liked = new Set(store.likedItemIds ?? []);

    const signals = new Set<string>();
    for (const item of store.wardrobe) {
      if (!liked.has(item.id)) continue;
      try {
        const { getMetadata } = await import("../metadata/store");
        const record = getMetadata(item.id);
        const attrs = record?.aiGenerated;
        if (!attrs) continue;
        for (const tag of attrs.styleTags) signals.add(tag);
        if (attrs.formality) signals.add(`formality:${attrs.formality}`);
      } catch {
        // metadata read is best-effort; never break the agent for it.
      }
    }

    const ordered = [...signals].sort();
    return {
      styleSignals: ordered.slice(0, 8),
      source: liked.size > 0 ? `store-preferences:${liked.size} liked items` : "store-preferences:no-feedback-yet",
    };
  }
}

/** Deterministic provider for offline dev + evaluation: explicit, empty, or seeded. */
export class MockPreferencesProvider implements PreferencesProvider {
  readonly name = "mock-preferences";
  private readonly signals: string[];

  constructor(styleSignals: string[] = [], private readonly label = "mock-preferences") {
    this.signals = [...styleSignals];
  }

  async getPreferences(): Promise<UserPreferences> {
    await new Promise((r) => setTimeout(r, 1));
    return { styleSignals: this.signals, source: this.label };
  }
}

/** No preferences at all — the app runs identically when the user has no data. */
export function defaultPreferencesProvider(): PreferencesProvider {
  if ((process.env.MYSTYLIST_PREFERENCES_PROVIDER ?? "mock").trim().toLowerCase() === "store") {
    return new StorePreferencesProvider();
  }
  return new MockPreferencesProvider();
}