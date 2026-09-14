import { NextResponse } from "next/server";
import { getStore, mutateStore } from "@/lib/db/store";
import type { Category } from "@/lib/types";

export const dynamic = "force-dynamic";

const CATEGORIES: Category[] = [
  "tops", "bottoms", "dresses", "outerwear",
  "shoes", "bags", "accessories", "others",
];

type PatchBody = {
  action?: "like" | "fields";
  value?: boolean;
  fields?: {
    name?: string;
    category?: Category;
    image?: string | null;
  };
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const store = getStore();
  const exists = store.wardrobe.some((i) => i.id === id);
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });

  const updated = mutateStore((s) => ({
    ...s,
    wardrobe: s.wardrobe.map((item) => {
      if (item.id !== id) return item;
      if (body.action === "like") return { ...item, liked: Boolean(body.value) };
      if (body.action === "fields" && body.fields) {
        const { name, category, image } = body.fields;
        const next = { ...item };
        if (name?.trim()) next.name = name.trim();
        if (category && CATEGORIES.includes(category)) next.category = category;
        if (image !== undefined) next.image = image;
        return next;
      }
      return item;
    }),
    likedItemIds: body.action === "like" ? toggleList(s.likedItemIds, id, Boolean(body.value)) : s.likedItemIds,
    dislikedItemIds:
      body.action === "like"
        ? toggleList(s.dislikedItemIds, id, body.value === false)
        : s.dislikedItemIds,
  }));

  return NextResponse.json({ item: updated.wardrobe.find((i) => i.id === id) });
}

function toggleList(list: string[], id: string, add: boolean): string[] {
  const without = list.filter((x) => x !== id);
  return add ? [...without, id] : without;
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const store = getStore();
  if (!store.wardrobe.some((i) => i.id === id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  mutateStore((s) => ({
    ...s,
    wardrobe: s.wardrobe.filter((i) => i.id !== id),
    likedItemIds: s.likedItemIds.filter((x) => x !== id),
    dislikedItemIds: s.dislikedItemIds.filter((x) => x !== id),
  }));
  return NextResponse.json({ ok: true });
}
