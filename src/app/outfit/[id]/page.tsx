import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getDict, pick } from "@/i18n";
import { getStore } from "@/lib/db/store";
import { OutfitActions } from "./OutfitActions";
import type { Lang } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function OutfitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lang: Lang = (await cookies()).get("lang")?.value === "zh" ? "zh" : "en";
  const dict = getDict(lang);
  const outfit = getStore().outfits.find((o) => o.id === id);
  if (!outfit) notFound();

  const stickers = outfit.stickers ?? [];

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-16">
      <Link href="/profile" className="btn-ghost mb-8">
        ← {dict.outfitDetail.back}
      </Link>

      <div className="grid gap-10 md:grid-cols-2 md:gap-14">
        {/* left: the board */}
        <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl bg-board">
          {stickers.map((s, i) => (
            <div
              key={`${s.id}-${i}`}
              className="absolute"
              style={{
                width: `${96 * (s.scale ?? 1)}px`,
                left: `${s.x * 100}%`,
                top: `${s.y * 100}%`,
                transform: `translate(-50%, -50%) rotate(${s.rotation ?? 0}deg)`,
              }}
            >
              <img src={s.src} alt="" className="w-full select-none" draggable={false} />
            </div>
          ))}
        </div>

        <div className="flex flex-col">
          <p className="eyebrow mb-3">{dict.stylist.saveBoard}</p>
          <h1 className="serif-display text-4xl leading-tight md:text-5xl">{pick(outfit.title, lang)}</h1>
          <p className="mt-2 text-sm text-ink-faint">
            {dict.outfitDetail.composedOf.replace("{n}", String(outfit.itemIds.length))}
          </p>

          <div className="mt-8">
            <OutfitActions outfitId={outfit.id} initialLiked={outfit.liked} initialDisliked={outfit.disliked} />
          </div>
        </div>
      </div>
    </div>
  );
}
