import { NextResponse } from "next/server";
import { getStore, mutateStore } from "@/lib/db/store";

export const dynamic = "force-dynamic";

type PatchBody = {
  action?: "like" | "dislike" | "save";
  value?: boolean;
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
  if (!store.outfits.some((o) => o.id === id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const updated = mutateStore((s) => ({
    ...s,
    outfits: s.outfits.map((o) => {
      if (o.id !== id) return o;
      switch (body.action) {
        case "like":
          return { ...o, liked: body.value ? true : null, disliked: false };
        case "dislike":
          return { ...o, disliked: Boolean(body.value), liked: body.value ? null : o.liked };
        case "save":
          return { ...o, saved: true };
        default:
          return o;
      }
    }),
  }));

  return NextResponse.json({ outfit: updated.outfits.find((o) => o.id === id) });
}

/** Delete a saved look — called after the user confirms in the UI. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const store = getStore();
  if (!store.outfits.some((o) => o.id === id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  mutateStore((s) => ({ ...s, outfits: s.outfits.filter((o) => o.id !== id) }));
  return NextResponse.json({ ok: true });
}
