import { NextResponse } from "next/server";
import { getStore, mutateStore } from "@/lib/db/store";
import type { Category, WardrobeItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const CATEGORIES: Category[] = [
  "tops", "bottoms", "dresses", "outerwear",
  "shoes", "bags", "accessories", "others",
];

const FALLBACK_STEM: Record<Category, string> = {
  tops: "tops-oxford-shirt",
  bottoms: "bottoms-wide-trousers",
  dresses: "dresses-slip-ivory",
  outerwear: "outer-trench-beige",
  shoes: "shoes-black-loafers",
  bags: "bags-leather-tote",
  accessories: "acc-gold-hoops",
  others: "hats-straw-sun",
};

export async function GET() {
  return NextResponse.json({ items: getStore().wardrobe });
}

interface AddBody {
  name?: string;
  category?: string;
  image?: string | null;
}

export async function POST(request: Request) {
  let body: AddBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Name and category are mandatory — nothing is added without them.
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!body.category || !CATEGORIES.includes(body.category as Category)) {
    return NextResponse.json({ error: "category is required" }, { status: 400 });
  }

  const category = body.category as Category;

  const item: WardrobeItem = {
    id: `user-${crypto.randomUUID().slice(0, 8)}`,
    stem: FALLBACK_STEM[category],
    image: body.image ?? null,
    category,
    name: body.name.trim(),
    addedAt: new Date().toISOString(),
    liked: false,
  };

  mutateStore((s) => ({ ...s, wardrobe: [item, ...s.wardrobe] }));
  return NextResponse.json({ item }, { status: 201 });
}
