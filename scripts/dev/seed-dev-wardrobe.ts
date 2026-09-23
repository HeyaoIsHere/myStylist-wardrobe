/**
 * scripts/dev/seed-dev-wardrobe.ts — DEV ONLY.
 *
 * Seeds the app's REAL runtime data (data/store.json, data/metadata.json,
 * data/embeddings.json — all gitignored) with the shared Phase 5/6 eval catalog
 * (18 items) THROUGH THE APP'S OWN storage layer, so the bounded Agent can be
 * manually tested in the browser with data that is grounded, deterministic, and
 * identical in behaviour to `npm run eval:agent`.
 *
 *   Usage:  node --import tsx scripts/dev/seed-dev-wardrobe.ts
 *   Reset:  delete data/store.json data/metadata.json data/embeddings.json
 *
 * Why the eval catalog and not invented data: this is the exact catalog the
 * golden trajectories in the agent eval assert against, so the 5 browser test
 * prompts below reproduce the documented trajectories exactly. Items carry no
 * real photos — each gets a tiny inline-SVG placeholder so the panel renders.
 */
import { loadCatalog } from "../eval/agent-golden";
import { getStore, saveStore } from "../../src/lib/db/store";
import { saveMetadataRecord } from "../../src/lib/metadata/store";
import {
  METADATA_SCHEMA_VERSION,
  computeConfidence,
  hasUsableAttributes,
} from "../../src/lib/metadata/schema";
import { getEmbeddingProvider } from "../../src/lib/retrieval/embedding";
import { FlatFileVectorStore } from "../../src/lib/retrieval/vectorstore";
import { reindexAll } from "../../src/lib/retrieval/indexer";
import type { WardrobeItem } from "../../src/lib/types";

/** Minimal placeholder image so the panel shows a real <img> per item. */
function svgDataUrl(itemName: string, hex: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640">` +
    `<rect width="512" height="640" fill="${hex}"/>` +
    `<text x="256" y="330" font-family="Inter,Arial,sans-serif" font-size="28" ` +
    `font-weight="600" text-anchor="middle" fill="#ffffff">${itemName}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function main(): Promise<void> {
  const catalog = loadCatalog(); // zod-validated against the app's own vocabularies
  const now = new Date().toISOString();

  // 1) the wardrobe itself (store.json)
  const store = getStore();
  store.wardrobe = catalog.map(({ item, attrs }): WardrobeItem => {
    const hex = attrs?.colors?.[0]?.hex ?? "#8a857a";
    return {
      id: item.id,
      stem: item.id,
      image: svgDataUrl(item.name, hex),
      category: item.category,
      name: item.name,
      addedAt: now,
      liked: false,
    };
  });
  saveStore(store);
  console.log(`store.json      → ${store.wardrobe.length} items`);

  // 2) the structured metadata the deterministic lane filters on (metadata.json)
  let records = 0;
  for (const { item, attrs } of catalog) {
    if (!attrs) continue;
    saveMetadataRecord({
      itemId: item.id,
      userProvided: { name: item.name, category: item.category },
      aiGenerated: attrs,
      system: {
        provider: "dev-seed",
        model: "eval-catalog-v1",
        version: METADATA_SCHEMA_VERSION,
        confidence: computeConfidence(attrs),
        extractedAt: now,
        requestId: "dev-seed",
        degraded: !hasUsableAttributes(attrs),
        attempts: 1,
        validationResult: "ok",
        errorCategory: null,
      },
    });
    records += 1;
  }
  console.log(`metadata.json   → ${records} records`);

  // 3) the vector index the semantic lane ranks on (embeddings.json)
  const report = await reindexAll(
    { emb: getEmbeddingProvider(), store: new FlatFileVectorStore() },
    catalog.map(({ item, attrs }) => ({ item, attrs })),
  );
  console.log(
    `embeddings.json → ${report.indexedTotal} vectors ` +
      `(created ${report.created} · pruned ${report.pruned})`,
  );

  console.log("\nDone. Start the dev server and open http://localhost:3000/agent");
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exitCode = 1;
});