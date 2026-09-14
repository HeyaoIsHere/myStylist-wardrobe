import type { Category, Localized } from "@/lib/types";

/**
 * AI Service abstraction. The MVP ships mock implementations so nothing
 * blocks on API keys — swapping in real models means replacing the bodies
 * here, not any caller.
 *
 * Reserved future hooks:
 *  - removeBackground   → real segmentation model (rembg / Cloudflare AI)
 *  - classifyClothing   → vision model (GPT-4V / Qwen-VL)
 *  - analyzeInspiration → vision + embedding model
 */
export interface AIProvider {
  removeBackground(imageRef: string): Promise<Localized>;
  classifyClothing(hash: string): Promise<{ suggestions: { category: Category | null } }>;
  analyzeInspiration(hash: string): Promise<{ tags: string[]; palette: string[] }>;
}

const CATEGORY_HINTS: Category[] = [
  "tops", "outerwear", "bottoms", "dresses", "shoes",
  "bags", "others", "accessories", "tops", "bottoms",
];

const hashOf = (s: string): number =>
  [...s].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);

/** The mock provider — replace with real implementations later. */
export const ai: AIProvider = {
  async removeBackground() {
    return {
      en: "Background removed (mock) — real segmentation swaps in later.",
      zh: "背景已去除（模拟）— 未来可接入真实抠图模型。",
    };
  },

  async classifyClothing(hash: string) {
    const h = hashOf(hash);
    return {
      suggestions: {
        category: CATEGORY_HINTS[h % CATEGORY_HINTS.length],
      },
    };
  },

  async analyzeInspiration(hash: string) {
    const h = hashOf(hash);
    const pools = [
      { tags: ["minimalist", "calm"], palette: ["#F0E7D8", "#C8A97E"] },
      { tags: ["city", "contrast"], palette: ["#26221D", "#948B7D"] },
      { tags: ["evening", "warm"], palette: ["#C08A6A", "#E9DCC3"] },
    ];
    return pools[h % pools.length];
  },
};
