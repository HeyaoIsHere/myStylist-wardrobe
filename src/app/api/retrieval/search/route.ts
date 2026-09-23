import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/db/store";
import { listMetadata } from "@/lib/metadata/store";
import { FORMALITY, SEASONS } from "@/lib/metadata/vocab";
import type { Category } from "@/lib/types";
import { getEmbeddingProvider } from "@/lib/retrieval/embedding";
import { FlatFileVectorStore } from "@/lib/retrieval/vectorstore";
import { semanticSearch } from "@/lib/retrieval/search";
import type { SearchDeps } from "@/lib/retrieval/search";

/**
 * POST /api/retrieval/search — semantic wardrobe retrieval (Phase 2).
 *
 * Body: { query, topK?, constraints? } where `constraints` is the OPTIONAL
 * deterministic hard lane (category/color/season/occasion/formality/…),
 * applied as a pre-filter before cosine ranking.
 *
 * Always returns shaped JSON; model/store trouble surfaces as `degraded:true`,
 * never an error, so the wardrobe flows are unaffected.
 */
export const dynamic = "force-dynamic";

const CATEGORIES: [Category, ...Category[]] = [
  "tops", "bottoms", "dresses", "outerwear", "shoes", "bags", "accessories", "others",
];

const bodySchema = z.object({
  query: z.string().trim().min(1).max(200),
  topK: z.number().int().min(1).max(50).optional().default(10),
  constraints: z
    .object({
      categories: z.array(z.enum(CATEGORIES)).optional(),
      colors: z.array(z.string().min(1).max(40)).optional(),
      materials: z.array(z.string().min(1).max(40)).optional(),
      seasons: z.array(z.enum(SEASONS)).optional(),
      occasions: z.array(z.string().min(1).max(40)).optional(),
      formality: z.enum(FORMALITY).nullable().optional(),
      excludeIds: z.array(z.string()).optional(),
    })
    .optional(),
});

function buildDeps(): SearchDeps {
  const store = getStore();
  const records = listMetadata();
  const metaById = new Map(records.map((r) => [r.itemId, r] as const));
  return {
    emb: getEmbeddingProvider(),
    store: new FlatFileVectorStore(),
    getItem: (id) => {
      const it = store.wardrobe.find((i) => i.id === id);
      return it ? { id: it.id, category: it.category } : null;
    },
    getAttrs: (id) => metaById.get(id)?.aiGenerated ?? null,
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { query, topK, constraints } = parsed.data;

  const deps = buildDeps();
  const result = await semanticSearch(deps, { query, topK, constraints });

  // Join with the wardrobe for display fields (names/categories/images).
  const store = getStore();
  const results = result.hits.map((h) => {
    const item = store.wardrobe.find((i) => i.id === h.itemId);
    return {
      itemId: h.itemId,
      name: item?.name ?? h.itemId,
      category: item?.category ?? "others",
      image: item?.image ?? null,
      score: h.score,
    };
  });

  return NextResponse.json({ ok: true, results, meta: result.meta });
}