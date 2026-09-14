"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/i18n/LanguageProvider";

interface OutfitActionsProps {
  outfitId: string;
  initialLiked: boolean | null;
  initialDisliked: boolean;
}

export function OutfitActions({ outfitId, initialLiked, initialDisliked }: OutfitActionsProps) {
  const { dict } = useI18n();
  const router = useRouter();
  const [liked, setLiked] = useState<boolean | null>(initialLiked);
  const [disliked, setDisliked] = useState(initialDisliked);
  const [busy, setBusy] = useState(false);

  async function patch(action: "like" | "dislike", value?: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/outfits/${outfitId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      });
      if (action === "like") {
        setLiked(true);
        setDisliked(false);
      }
      if (action === "dislike") {
        setDisliked(true);
        setLiked(null);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <button
        onClick={() => patch("like", true)}
        disabled={busy}
        className={`btn-ghost text-[12px] uppercase tracking-[0.14em] ${liked ? "text-ink" : ""}`}
      >
        {liked ? "✓ " : ""}{dict.common.like}
      </button>
      <button
        onClick={() => patch("dislike", true)}
        disabled={busy}
        className={`btn-ghost text-[12px] uppercase tracking-[0.14em] ${disliked ? "text-ink" : ""}`}
      >
        {disliked ? "✓ " : ""}{dict.common.dislike}
      </button>
    </div>
  );
}
