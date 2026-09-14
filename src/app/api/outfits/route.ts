import { NextResponse } from "next/server";
import { getStore, mutateStore } from "@/lib/db/store";
import type { BoardSticker, OutfitRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const saved = getStore().outfits.filter((o) => o.saved);
  return NextResponse.json({ outfits: saved });
}

export async function POST(request: Request) {
  let body: Partial<OutfitRecord> & { stickers?: BoardSticker[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!body.itemIds?.length) {
    return NextResponse.json({ error: "itemIds required" }, { status: 400 });
  }

  const outfit: OutfitRecord = {
    id: body.id ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: body.title ?? { en: "Board look", zh: "画板造型" },
    itemIds: body.itemIds,
    stickers: Array.isArray(body.stickers) ? body.stickers : undefined,
    saved: true,
    liked: body.liked ?? null,
    disliked: false,
  };

  mutateStore((s) => ({
    ...s,
    outfits: [outfit, ...s.outfits.filter((o) => o.id !== outfit.id)],
  }));
  return NextResponse.json({ outfit }, { status: 201 });
}
