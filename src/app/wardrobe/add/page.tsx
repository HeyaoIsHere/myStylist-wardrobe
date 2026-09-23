"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/i18n/LanguageProvider";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { MattingEditor } from "@/components/ui/MattingEditor";
import { fileToDataUrl } from "@/lib/client/image";
import type { Category } from "@/lib/types";

const CATEGORY_KEYS: Category[] = [
  "tops", "bottoms", "dresses", "outerwear",
  "shoes", "bags", "accessories", "others",
];

interface Hints {
  category: Category | null;
}

export default function AddItemPage() {
  const { dict } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  const [photo, setPhoto] = useState<string | null>(null); // original photo
  const [image, setImage] = useState<string | null>(null); // cutout sticker (transparent PNG)
  const [hints, setHints] = useState<Hints>({ category: null });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form fields — name & category start EMPTY and are mandatory
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  const valid = Boolean(name.trim()) && category !== null;

  /** Back to the very beginning — the empty drop-zone state. */
  function resetAll() {
    setPhoto(null);
    setImage(null);
    setHints({ category: null });
    setName("");
    setCategory(null);
    setTried(false);
    setError(null);
  }

  async function handleFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError(dict.errors.uploadFail);
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file, 900, 0.85);
      setPhoto(dataUrl);
    } catch {
      setError(dict.errors.generic);
    }
  }

  async function handleSave() {
    setTried(true);
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const payload = JSON.stringify({
        image,
        name: name.trim(),
        category,
      });
      // retry once — the first attempt can hit a cold route compile
      let res = await fetch("/api/wardrobe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 1200));
        res = await fetch("/api/wardrobe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "save failed");
      }
      // HARD navigation + cache-buster — guarantees the wardrobe grid and
      // profile counts re-render from the server with the new piece
      window.location.href = `/stylist?t=${Date.now()}`;
    } catch {
      setSaving(false);
      setError(dict.errors.generic);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-16">
      <SectionHeading eyebrow={dict.brand.tagline} title={dict.addItem.title} sub={dict.addItem.subtitle} />

      {/* — step 1: pick a photo — */}
      {!photo && (
        <div
          className={`hairline flex min-h-[380px] cursor-pointer flex-col items-center justify-center gap-4 border-dashed bg-surface px-6 text-center transition-colors ${
            dragging ? "border-ink bg-camel-soft/40" : "hover:border-ink/50"
          }`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFile(file);
          }}
        >
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-ink-soft">
            <rect x="3" y="5" width="18" height="16" rx="1" />
            <path d="M5 16l4.5-4.5L14 16l3-3 2.5 2.5" />
            <circle cx="9" cy="10" r="1.6" />
          </svg>
          <p className="serif-display text-2xl">{dict.addItem.drop}</p>
          <p className="text-sm text-ink-soft">
            {dict.addItem.orBrowse} · {dict.addItem.hint}
          </p>
          {error && <p className="text-sm text-terra">{error}</p>}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {/* — step 2: auto matting (GroundingDINO + RMBG-1.4, SAM2 fallback) + manual repair — */}
      {photo && !image && (
        <MattingEditor
          src={photo}
          onDone={(url) => setImage(url)}
          onHint={(category) => setHints({ category })}
          onCancel={() => setPhoto(null)}
        />
      )}

      {/* — step 3: review & edit — same 3:4 image area as the matting page — */}
      {image && (
        <div className="grid gap-8 md:grid-cols-[minmax(0,460px)_1fr]">
          <div>
            <div className="checker hairline aspect-[3/4] w-full max-w-[460px] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element -- cutout result */}
              <img src={image} alt={name || "item"} className="h-full w-full object-contain" />
            </div>
            <div className="mt-3 flex max-w-[460px] items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.18em] text-ink-faint">{dict.addItem.cutoutHint}</p>
              <button className="btn-ghost text-[12px] uppercase tracking-[0.12em]" onClick={() => setImage(null)}>
                ← {dict.addItem.autoCutout}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-5">
            <p className="serif-display text-2xl">{dict.addItem.result}</p>

            {/* name — required, single field */}
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-soft">
              {dict.addItem.name} <span className="text-terra">*</span>
              <input
                className={`input ${tried && !name.trim() ? "border-terra" : ""}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={dict.addItem.namePlaceholder}
              />
            </label>

            {/* category — required, starts empty */}
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-soft">
              {dict.addItem.category} <span className="text-terra">*</span>
              <select
                className={`input ${tried && category === null ? "border-terra" : ""}`}
                value={category ?? ""}
                onChange={(e) => setCategory((e.target.value || null) as Category | null)}
              >
                <option value="">{dict.addItem.selectCategory}</option>
                {CATEGORY_KEYS.map((c) => (
                  <option key={c} value={c}>{dict.categories[c]}</option>
                ))}
              </select>
              {hints.category && category === null && (
                <button
                  className="mt-1.5 flex items-center gap-1.5 text-left text-[12px] text-ink-faint hover:text-ink"
                  onClick={() => setCategory(hints.category)}
                >
                  <span className="text-camel">✦</span>
                  {dict.addItem.aiSuggests}: {dict.categories[hints.category]}
                </button>
              )}
            </label>

            {tried && !valid && (
              <p className="text-sm text-terra">{dict.addItem.requiredHint}</p>
            )}
            {error && <p className="text-sm text-terra">{error}</p>}

            <div className="mt-2 flex items-center gap-4">
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? dict.common.generating : dict.addItem.finish}
              </button>
              <button className="btn-ghost" onClick={resetAll}>{dict.common.cancel}</button>
            </div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink-faint">{dict.addItem.editHint}</p>
          </div>
        </div>
      )}
    </div>
  );
}
