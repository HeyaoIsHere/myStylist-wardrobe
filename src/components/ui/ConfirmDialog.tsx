"use client";

import { useI18n } from "@/i18n/LanguageProvider";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A quiet-luxury confirmation modal — deletes never happen without it. */
export function ConfirmDialog({ open, title, message, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const { dict } = useI18n();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-5"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-paper p-7"
        style={{ animation: "fade-up .3s ease both" }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="serif-display text-2xl leading-snug">{title}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            {dict.common.cancel}
          </button>
          <button
            className="rounded-full bg-terra px-5 py-2 text-[13px] text-paper transition-colors hover:bg-terra/90 disabled:opacity-60"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? dict.common.generating : dict.common.delete}
          </button>
        </div>
      </div>
    </div>
  );
}
