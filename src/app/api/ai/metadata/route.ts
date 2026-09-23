import { NextResponse } from "next/server";
import { getStore } from "@/lib/db/store";
import { getMetadata } from "@/lib/metadata/store";
import { resolveItemImage } from "@/lib/metadata/image";
import { extractClothingMetadata } from "@/lib/metadata/service";
import { defaultIndexDeps, ensureIndexed } from "@/lib/retrieval/indexer";

/**
 * POST /api/ai/metadata — independent, post-save metadata extraction (Phase 1).
 *
 * The client sends only { itemId }. The server resolves the minimal cutout
 * representation from the saved item (the user never re-sends the image) and
 * runs the provider-agnostic extraction service. The response is ALWAYS a
 * safe, shaped JSON: on model trouble the call resolves with `degraded:true`,
 * never with an error that could block the wardrobe flow. This route is the
 * only place the UI talks to AI metadata — never a provider directly.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { itemId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const itemId = body.itemId?.trim();
  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  const item = getStore().wardrobe.find((i) => i.id === itemId);
  if (!item) {
    return NextResponse.json({ error: "item not found" }, { status: 404 });
  }

  try {
    const imageDataUrl = resolveItemImage(item.image);
    const result = await extractClothingMetadata({
      itemId,
      name: item.name,
      category: item.category,
      imageDataUrl,
    });
    // Phase 2: index the freshly-saved metadata into the semantic vector store.
    // Fail-safe and non-blocking — ensureIndexed catches internally; the UI is
    // fire-and-forget and `reindex` can always repair later.
    void ensureIndexed(
      { id: itemId, name: item.name, category: item.category },
      getMetadata(itemId)?.aiGenerated ?? null,
      defaultIndexDeps(),
    ).catch(() => {});
    return NextResponse.json({
      ok: true,
      degraded: result.degraded,
      metadata: result.attrs,
      meta: {
        provider: result.system.provider,
        model: result.system.model,
        version: result.system.version,
        confidence: result.system.confidence,
      },
      requestId: result.requestId,
    });
  } catch {
    // Last-resort safety net: extraction should never throw, but if it does,
    // the wardrobe flow is unaffected — report a clean degraded result.
    return NextResponse.json({
      ok: false,
      degraded: true,
      metadata: null,
      error: "metadata extraction unavailable",
    });
  }
}