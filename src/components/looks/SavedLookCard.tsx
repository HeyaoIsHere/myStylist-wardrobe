"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Lang, OutfitRecord } from "@/lib/types";
import { useI18n } from "@/i18n/LanguageProvider";
import { pick } from "@/i18n";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface SavedLookCardProps {
  outfit: OutfitRecord;
  lang: Lang;
  /** resolved images for non-board looks (wardrobe id → image) */
  fallbackImages: { id: string; image: string }[];
}

/** A saved-look card: board preview + title + delete (behind confirmation). */
export function SavedLookCard({ outfit, lang, fallbackImages }: SavedLookCardProps) {
  const { dict } = useI18n();
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isBoard = Array.isArray(outfit.stickers) && outfit.stickers.length > 0;
  const items = outfit.itemIds
    .map((id) => fallbackImages.find((f) => f.id === id))
    .filter((f): f is { id: string; image: string } => Boolean(f));

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/outfits/${outfit.id}`, { method: "DELETE" });
      if (res.ok) {
        setConfirmOpen(false);
        // server re-reads the store → list and counts update together
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group relative">
      <Link href={`/outfit/${outfit.id}`} className="block">
        {isBoard ? (
          <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl bg-board">
            {outfit.stickers!.map((s, i) => (
              <div
                key={`${s.id}-${i}`}
                className="absolute"
                style={{
                  width: `${(96 * (s.scale ?? 1)) / 2.4}px`,
                  left: `${s.x * 100}%`,
                  top: `${s.y * 100}%`,
                  transform: `translate(-50%, -50%) rotate(${s.rotation ?? 0}deg)`,
                }}
              >
                <img src={s.src} alt="" className="w-full select-none" draggable={false} />
              </div>
            ))}
          </div>
        ) : (
          <div className="hairline grid grid-cols-2 overflow-hidden bg-surface">
            {items.slice(0, 4).map((item, i) => (
              <img
                key={`${i}-${item.id}`}
                src={item.image}
                alt=""
                loading="lazy"
                className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
              />
            ))}
          </div>
        )}
        <p className="serif-display mt-3 text-xl transition-colors group-hover:text-ink-soft">
          {pick(outfit.title, lang)}
        </p>
        <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          {dict.stylist.saveBoard}
        </p>
      </Link>

      {/* hollow circle × — translucent, delete with confirmation */}
      <button
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-white/40 text-[14px] leading-none text-ink opacity-70 shadow-hair transition-all hover:bg-white/80 hover:opacity-100 group-hover:opacity-100"
        onClick={() => setConfirmOpen(true)}
        aria-label={dict.profile.deleteLook}
      >
        ×
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title={dict.profile.deleteLook}
        message={dict.profile.deleteLookConfirm}
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
