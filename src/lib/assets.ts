import fs from "node:fs";
import path from "node:path";

/**
 * Resolves an item/inspiration stem to its final image path.
 * scripts/fetch-assets.mjs writes assets-manifest.json recording whether a
 * real photo or the generated SVG illustration is used for each stem.
 */
let cache: { wardrobe: Record<string, string>; inspo: Record<string, string> } | null = null;

function manifest() {
  if (!cache) {
    try {
      cache = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "src", "lib", "assets-manifest.json"), "utf8"),
      );
    } catch {
      cache = { wardrobe: {}, inspo: {} };
    }
  }
  return cache!;
}

export function assetPath(stem: string, kind: "wardrobe" | "inspo"): string {
  return manifest()[kind][stem] ?? `/images/${kind}/${stem}.svg`;
}

export function itemImage(item: { stem: string; image?: string | null }): string {
  return item.image || assetPath(item.stem, "wardrobe");
}
