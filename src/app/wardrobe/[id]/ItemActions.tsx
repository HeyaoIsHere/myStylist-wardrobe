"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/i18n/LanguageProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function ItemActions({ itemId }: { itemId: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await fetch(`/api/wardrobe/${itemId}`, { method: "DELETE" });
      setConfirmOpen(false);
      router.push("/stylist");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <button className="btn-ghost" onClick={() => setConfirmOpen(true)} disabled={busy}>
        {dict.itemDetail.delete}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={dict.itemDetail.delete}
        message={dict.itemDetail.deleteConfirm}
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
