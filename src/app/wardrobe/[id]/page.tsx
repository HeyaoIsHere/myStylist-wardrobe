import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getDict } from "@/i18n";
import { getStore } from "@/lib/db/store";
import { itemImage } from "@/lib/assets";
import { CutoutImage } from "@/components/ui/CutoutImage";
import { ItemActions } from "./ItemActions";
import type { Lang } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lang: Lang = (await cookies()).get("lang")?.value === "zh" ? "zh" : "en";
  const dict = getDict(lang);
  const item = getStore().wardrobe.find((i) => i.id === id);
  if (!item) notFound();

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-16">
      <Link href="/stylist" className="btn-ghost mb-8">
        ← {dict.common.back}
      </Link>

      <div className="grid gap-10 md:grid-cols-2 md:gap-14">
        <div>
          <div className="hairline overflow-hidden bg-white">
            <CutoutImage src={itemImage(item)} alt={item.name} className="aspect-[4/5] w-full object-cover" />
          </div>
        </div>

        <div className="flex flex-col">
          <p className="eyebrow mb-3">{dict.categories[item.category]}</p>
          <h1 className="serif-display text-4xl leading-tight md:text-5xl">{item.name}</h1>

          <div className="mt-8 flex flex-col gap-4">
            <Link href="/stylist" className="btn-outline">
              ✦ {dict.itemDetail.styleThis}
            </Link>
            <ItemActions itemId={item.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
