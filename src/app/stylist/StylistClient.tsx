"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Category, WardrobeItem } from "@/lib/types";
import { useI18n } from "@/i18n/LanguageProvider";
import { pick } from "@/i18n";
import { cutoutCanvas } from "@/lib/client/cutout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type ResolvedItem = WardrobeItem & { image: string };

interface Sticker {
  id: string;
  x: number; // centre position as fraction of board size
  y: number;
  src: string; // transparent PNG data URL
  scale: number; // 1 = default
  rotation?: number; // degrees, 0 = upright
}

const STICKER_BASE_W = 96; // px at scale 1

/** Category filter order — mirrors the pill row in the header. */
const CATEGORY_FILTERS: (Category | "all")[] = [
  "all", "tops", "bottoms", "dresses", "outerwear",
  "shoes", "bags", "accessories", "others",
];

interface StylistClientProps {
  items: ResolvedItem[];
}

export function StylistClient({ items }: StylistClientProps) {
  const { dict, lang } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<Category | "all">("all");

  // — sticker board state —
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [savingBoard, setSavingBoard] = useState(false);
  const [boardMsg, setBoardMsg] = useState<"saved" | "empty" | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const stickerCache = useRef<Map<string, Promise<string>>>(new Map());
  const dragRef = useRef<{
    kind: "from-grid" | "sticker" | "resize" | "rotate";
    id?: string;
    startX: number;
    startY: number;
    dragged: boolean;
    stickerIndex?: number;
    origX?: number;
    origY?: number;
    baseScale?: number;
    baseRotation?: number;
    startAngle?: number;
    centerX?: number;
    centerY?: number;
    srcPromise?: Promise<string>;
  } | null>(null);

  // — delete confirmation for wardrobe pieces —
  const [confirmItem, setConfirmItem] = useState<ResolvedItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (cat === "all" || i.category === cat) &&
        (!q || i.name.toLowerCase().includes(q) || dict.categories[i.category].toLowerCase().includes(q)),
    );
  }, [items, query, dict, cat]);

  /** Transparent-PNG sticker source, cut out lazily and cached per item. */
  function stickerSrc(item: ResolvedItem): Promise<string> {
    if (item.image?.startsWith("data:image/png")) return Promise.resolve(item.image);
    // AI matting output — already a transparent PNG, use as-is
    if (item.image?.startsWith("/uploads/")) return Promise.resolve(item.image);
    const cached = stickerCache.current.get(item.id);
    if (cached) return cached;
    const p = cutoutCanvas(item.image, 420)
      .then((c) => c.toDataURL("image/png"))
      .catch(() => item.image);
    stickerCache.current.set(item.id, p);
    return p;
  }

  // — drag mechanics: window-level listeners while a drag is active —
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (!d.dragged && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 8) {
        d.dragged = true;
      }
      if (!d.dragged) return;
      if (d.kind === "from-grid") {
        setGhost({ x: e.clientX, y: e.clientY });
      } else if (d.kind === "sticker" && d.stickerIndex !== undefined && d.origX !== undefined && d.origY !== undefined) {
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return;
        const dx = (e.clientX - d.startX) / rect.width;
        const dy = (e.clientY - d.startY) / rect.height;
        const x = Math.min(1, Math.max(0, d.origX + dx));
        const y = Math.min(1, Math.max(0, d.origY + dy));
        setStickers((cur) => cur.map((s, i) => (i === d.stickerIndex ? { ...s, x, y } : s)));
      } else if (d.kind === "resize" && d.stickerIndex !== undefined && d.baseScale !== undefined) {
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        const scale = Math.min(3.5, Math.max(0.35, d.baseScale * (dist / 30)));
        setStickers((cur) => cur.map((s, i) => (i === d.stickerIndex ? { ...s, scale } : s)));
      } else if (
        d.kind === "rotate" && d.stickerIndex !== undefined &&
        d.baseRotation !== undefined && d.startAngle !== undefined &&
        d.centerX !== undefined && d.centerY !== undefined
      ) {
        const angle = Math.atan2(e.clientY - d.centerY, e.clientX - d.centerX);
        let rot = d.baseRotation + ((angle - d.startAngle) * 180) / Math.PI;
        rot = ((rot % 360) + 360) % 360;
        // gentle snap to 45° multiples so stickers straighten easily
        const snapped = Math.round(rot / 45) * 45;
        if (Math.abs(rot - snapped) < 3) rot = snapped;
        setStickers((cur) => cur.map((s, i) => (i === d.stickerIndex ? { ...s, rotation: rot } : s)));
      }
    }
    function onUp(e: PointerEvent) {
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (!d || !d.dragged || d.kind !== "from-grid") return;
      const rect = boardRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom
      ) {
        return; // dropped outside the board
      }
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (d.id && d.srcPromise) {
        d.srcPromise.then((src) =>
          setStickers((cur) => [...cur, { id: d.id!, x, y, src, scale: 1 }]),
        );
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function beginGridDrag(e: React.PointerEvent, item: ResolvedItem) {
    dragRef.current = {
      kind: "from-grid",
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      dragged: false,
      srcPromise: stickerSrc(item),
    };
  }

  function beginStickerDrag(e: React.PointerEvent, index: number) {
    e.preventDefault();
    const s = stickers[index];
    dragRef.current = {
      kind: "sticker",
      startX: e.clientX,
      startY: e.clientY,
      dragged: true,
      stickerIndex: index,
      origX: s.x,
      origY: s.y,
    };
  }

  function beginResizeDrag(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const s = stickers[index];
    dragRef.current = {
      kind: "resize",
      startX: e.clientX,
      startY: e.clientY,
      dragged: true,
      stickerIndex: index,
      baseScale: s.scale,
    };
  }

  function beginRotateDrag(e: React.PointerEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const s = stickers[index];
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.left + s.x * rect.width;
    const centerY = rect.top + s.y * rect.height;
    dragRef.current = {
      kind: "rotate",
      startX: e.clientX,
      startY: e.clientY,
      dragged: true,
      stickerIndex: index,
      baseRotation: s.rotation ?? 0,
      startAngle: Math.atan2(e.clientY - centerY, e.clientX - centerX),
      centerX,
      centerY,
    };
  }

  function removeSticker(index: number) {
    setStickers((cur) => cur.filter((_, i) => i !== index));
  }

  /** Remove a wardrobe piece — always behind a confirmation dialog. */
  async function deleteItem() {
    if (!confirmItem) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/wardrobe/${confirmItem.id}`, { method: "DELETE" });
      if (res.ok) {
        setConfirmItem(null);
        // server re-reads the store → grid and profile counts update
        router.refresh();
      }
    } finally {
      setDeleting(false);
    }
  }

  async function saveBoard() {
    if (stickers.length === 0) {
      setBoardMsg("empty");
      setTimeout(() => setBoardMsg(null), 2600);
      return;
    }
    setSavingBoard(true);
    try {
      const res = await fetch("/api/outfits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemIds: stickers.map((s) => s.id),
          stickers,
          title: pick(dict.stylist.boardTitles, lang),
        }),
      });
      if (res.ok) {
        setBoardMsg("saved");
        setTimeout(() => setBoardMsg(null), 2600);
      }
    } finally {
      setSavingBoard(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
      {/* — compact header: category filter pills + search/add — */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 md:px-8">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={dict.addItem.category}>
          {CATEGORY_FILTERS.map((key) => (
            <button
              key={key}
              onClick={() => setCat(key)}
              aria-pressed={cat === key}
              className={`rounded-full px-4 py-1.5 text-[13px] transition-colors ${
                cat === key
                  ? "bg-ink text-paper"
                  : "border border-line text-ink-soft hover:border-ink/40 hover:text-ink"
              }`}
            >
              {dict.categories[key]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            className="input w-40 py-1.5 text-[13px] md:w-52"
            placeholder={dict.wardrobe.title}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search wardrobe"
          />
          <Link href="/wardrobe/add" className="btn-primary px-4 py-2 text-[13px]">
            {dict.common.add} +
          </Link>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-5 lg:grid-rows-1">
        {/* — left: the wardrobe, 60% width, scrolls vertically — */}
        <section className="flex min-h-0 flex-col border-b border-line lg:col-span-3 lg:border-b-0">
          <div className="flex shrink-0 items-center justify-between px-5 py-3 md:px-8">
            <p className="eyebrow">{dict.wardrobe.count.replace("{n}", String(visible.length))}</p>
            <p className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">{dict.stylist.step1Hint}</p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-4 px-8 py-20 text-center">
                <p className="serif-display text-3xl">{dict.stylist.noItems}</p>
                <p className="max-w-sm text-sm text-ink-soft">{dict.stylist.noItemsHint}</p>
                <Link href="/wardrobe/add" className="btn-primary mt-2">
                  {dict.wardrobe.addFirst}
                </Link>
              </div>
            ) : visible.length === 0 ? (
              <div className="flex items-center justify-center px-8 py-20">
                <p className="text-sm text-ink-faint">
                  {query.trim() || cat !== "all" ? dict.wardrobe.emptyCategory : dict.wardrobe.empty}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5">
                {visible.map((item) => (
                  <div
                    key={item.id}
                    onPointerDown={(e) => beginGridDrag(e, item)}
                    className="group relative block aspect-[3/4] cursor-grab overflow-hidden text-left active:cursor-grabbing"
                  >
                    <img
                      src={item.image}
                      alt={item.name}
                      loading="lazy"
                      draggable={false}
                      className="absolute inset-0 h-full w-full object-contain p-2 transition-transform duration-700 group-hover:scale-[1.04]"
                    />
                    <span
                      className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/75 via-ink/30 to-transparent px-3 pb-2.5 pt-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                    >
                      <span className="block truncate text-[12px] text-paper">{item.name}</span>
                      <span className="block text-[10px] uppercase tracking-[0.14em] text-paper/70">
                        {dict.categories[item.category]}
                      </span>
                    </span>
                    {/* hollow circle × — translucent, delete with confirmation */}
                    <button
                      className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-white/40 text-[13px] leading-none text-ink opacity-70 shadow-hair transition-all hover:bg-white/80 hover:opacity-100 group-hover:opacity-100"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setConfirmItem(item)}
                      aria-label={dict.itemDetail.delete}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* — right: the creative board, 40% width — */}
        <aside className="flex min-h-0 flex-col border-t border-line lg:col-span-2 lg:border-l lg:border-t-0">
          <div className="flex min-h-0 flex-1 flex-col px-8 py-5 md:px-12 md:py-6">
            <div
              ref={boardRef}
              className="relative min-h-0 w-full flex-1 touch-none select-none overflow-hidden rounded-2xl bg-board"
            >
              {stickers.map((s, i) => (
                <div
                  key={`${s.id}-${i}`}
                  className="absolute z-[1] cursor-grab active:cursor-grabbing"
                  style={{
                    width: `${STICKER_BASE_W * (s.scale ?? 1)}px`,
                    left: `${s.x * 100}%`,
                    top: `${s.y * 100}%`,
                    transform: `translate(-50%, -50%) rotate(${s.rotation ?? 0}deg)`,
                    touchAction: "none",
                  }}
                  onPointerDown={(e) => beginStickerDrag(e, i)}
                >
                  <img src={s.src} alt="" draggable={false} className="pointer-events-none w-full select-none" />
                  {/* rotate handle — top-left, translucent */}
                  <button
                    className="absolute -left-3 -top-3 flex h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-white/40 text-ink shadow-hair transition-colors hover:bg-white/80"
                    style={{ touchAction: "none", cursor: "grab" }}
                    onPointerDown={(e) => beginRotateDrag(e, i)}
                    aria-label={dict.stylist.rotate}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-3-6.7" />
                      <path d="M21 3v5h-5" />
                    </svg>
                  </button>
                  {/* hollow circle × — translucent */}
                  <button
                    className="absolute -right-2.5 -top-2.5 flex h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-white/40 text-[13px] leading-none text-ink shadow-hair transition-colors hover:bg-white/80"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeSticker(i)}
                    aria-label={dict.common.remove}
                  >
                    ×
                  </button>
                  {/* resize handle — bottom-right, larger hit area */}
                  <button
                    className="absolute -bottom-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-white/40 text-ink shadow-hair transition-colors hover:bg-white/80"
                    style={{ touchAction: "none", cursor: "nwse-resize" }}
                    onPointerDown={(e) => beginResizeDrag(e, i)}
                    aria-label={dict.stylist.resize}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 20 20 4" />
                      <path d="M14 4h6v6" />
                      <path d="M4 10v6h6" />
                    </svg>
                  </button>
                </div>
              ))}

              {/* — controls live INSIDE the board: borderless, rounded — */}
              {boardMsg && (
                <p className="absolute bottom-3 left-3 z-20 max-w-[60%] bg-paper/90 px-3 py-1.5 text-[12px] leading-snug">
                  {boardMsg === "saved" ? (
                    <>
                      ✓ {dict.stylist.boardSaved} —{" "}
                      <Link href="/profile" className="underline underline-offset-4">{dict.profile.savedOutfits} →</Link>
                    </>
                  ) : (
                    <span className="text-terra">{dict.stylist.boardEmpty}</span>
                  )}
                </p>
              )}
              <div className="absolute bottom-3 right-3 z-20 flex gap-2">
                <button
                  className="rounded-full bg-paper/85 px-4 py-2 text-[13px] text-ink transition-colors hover:bg-paper"
                  onClick={() => {
                    setStickers([]);
                    setBoardMsg(null);
                  }}
                >
                  {dict.stylist.clearBoard}
                </button>
                <button
                  className="rounded-full bg-ink px-4 py-2 text-[13px] text-paper transition-colors hover:bg-ink/85"
                  onClick={saveBoard}
                  disabled={savingBoard}
                >
                  {savingBoard ? dict.common.generating : dict.stylist.saveBoard}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* — drag ghost following the pointer — */}
      {ghost && (
        <div
          className="pointer-events-none fixed z-50 w-24 md:w-28"
          style={{ left: ghost.x, top: ghost.y, transform: "translate(-50%, -50%)" }}
        >
          <div className="shimmer-bg aspect-[4/5] w-full rounded-xl" />
        </div>
      )}

      {/* — delete confirmation — */}
      <ConfirmDialog
        open={confirmItem !== null}
        title={dict.itemDetail.delete}
        message={dict.itemDetail.deleteConfirm}
        busy={deleting}
        onConfirm={deleteItem}
        onCancel={() => setConfirmItem(null)}
      />
    </div>
  );
}
