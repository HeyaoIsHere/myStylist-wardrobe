"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/LanguageProvider";

/** Meitu-style mask editor — works DIRECTLY on the original photo at its
 *  natural size. The photo stays fully visible; the keep region is a
 *  translucent green overlay. Brush paints more green, eraser removes it.
 *  The final 512 cutout (crop → scale → centre) happens only when the
 *  parent clicks Done, via the live onSave output. */
interface CutoutEditorProps {
  photoSrc: string; // original photo (data URL), natural size
  maskSrc?: string; // green overlay PNG, same size — alpha = keep region
  initialEmpty?: boolean; // ignore the overlay alpha — start with no mask
  onSave: (finalCutoutDataUrl: string) => void; // fires live after changes
}

const CANVAS_OUT = 512;
const FIT = 460;
const MIN_SIZE = 6;
const MAX_SIZE = 90;

export function CutoutEditor({ photoSrc, maskSrc, initialEmpty, onSave }: CutoutEditorProps) {
  const { dict } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photoRef = useRef<ImageData | null>(null); // original photo RGB
  const maskRef = useRef<Uint8ClampedArray | null>(null); // keep mask 0-255
  const undoRef = useRef<Uint8ClampedArray[]>([]);
  const redoRef = useRef<Uint8ClampedArray[]>([]);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const saveTimer = useRef<number | null>(null);

  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<"brush" | "erase" | null>(null);
  const [size, setSize] = useState(36); // in ORIGINAL-photo pixels
  const [ready, setReady] = useState(false);
  const [, bump] = useState(0); // re-render for undo/redo disabled states

  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const load = () => {
      const photo = new Image();
      const overlay = maskSrc ? new Image() : null;
      let photoOk = false;
      let overlayOk = overlay === null;
      const compose = () => {
        if (!alive || !photoOk || !overlayOk) return;
        const c = canvasRef.current;
        if (!c) return;
        const w = photo.naturalWidth;
        const h = photo.naturalHeight;
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(photo, 0, 0);
        photoRef.current = ctx.getImageData(0, 0, w, h);
        const mask = new Uint8ClampedArray(w * h);
        if (!initialEmpty && overlay) {
          const oc = document.createElement("canvas");
          oc.width = w;
          oc.height = h;
          const octx = oc.getContext("2d")!;
          octx.drawImage(overlay, 0, 0, w, h);
          const od = octx.getImageData(0, 0, w, h).data;
          for (let i = 0; i < w * h; i++) mask[i] = od[i * 4 + 3];
        }
        maskRef.current = mask;
        draw();
        setReady(true);
        // initial export — the parent's Done button needs the AI-mask cutout
        // even when the user never enters edit mode
        const png = buildCutout();
        if (png) onSave(png);
      };
      const retry = () => {
        // transient server hiccups happen (hot reload, dev restarts) —
        // keep retrying so the editor never stays dead
        if (!alive) return;
        attempts += 1;
        setTimeout(load, attempts <= 4 ? 400 : 2000);
      };
      photo.onload = () => {
        photoOk = true;
        compose();
      };
      photo.onerror = retry;
      photo.src = photoSrc;
      if (overlay) {
        // crossOrigin so a cloud-hosted overlay (different origin) can be
        // drawn to canvas without tainting it — the service sends CORS headers
        overlay.crossOrigin = "anonymous";
        overlay.onload = () => {
          overlayOk = true;
          compose();
        };
        overlay.onerror = retry;
        overlay.src = maskSrc!;
      }
    };
    load();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only on inputs
  }, [photoSrc, maskSrc, initialEmpty]);

  /** Photo + translucent green over the kept region. */
  function draw() {
    const photo = photoRef.current;
    const mask = maskRef.current;
    const c = canvasRef.current;
    if (!c || !photo || !mask) return;
    const ctx = c.getContext("2d")!;
    const n = c.width * c.height;
    const out = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < n; i++) {
      out.data[i * 4] = photo.data[i * 4];
      out.data[i * 4 + 1] = photo.data[i * 4 + 1];
      out.data[i * 4 + 2] = photo.data[i * 4 + 2];
      if (mask[i] > 40) {
        out.data[i * 4] = out.data[i * 4] * 0.55 + 46 * 0.45;
        out.data[i * 4 + 1] = out.data[i * 4 + 1] * 0.55 + 204 * 0.45;
        out.data[i * 4 + 2] = out.data[i * 4 + 2] * 0.55 + 113 * 0.45;
      }
      out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  }

  /** Final cutout: photo RGB × mask → crop to opaque bounds → fit 512. */
  function buildCutout(): string {
    const photo = photoRef.current;
    const mask = maskRef.current;
    const c = canvasRef.current;
    if (!photo || !mask || !c) return "";
    const w = c.width;
    const h = c.height;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x] > 30) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return ""; // nothing marked
    const pad = Math.max(8, Math.round(0.03 * Math.max(x1 - x0, y1 - y0)));
    const cx0 = Math.max(0, x0 - pad);
    const cy0 = Math.max(0, y0 - pad);
    const cx1 = Math.min(w - 1, x1 + pad);
    const cy1 = Math.min(h - 1, y1 + pad);
    const cw = cx1 - cx0 + 1;
    const ch = cy1 - cy0 + 1;
    // RGBA crop from photo RGB × mask
    const crop = document.createElement("canvas");
    crop.width = cw;
    crop.height = ch;
    const cctx = crop.getContext("2d")!;
    const cd = cctx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = (cy0 + y) * w + (cx0 + x);
        const di = y * cw + x;
        cd.data[di * 4] = photo.data[si * 4];
        cd.data[di * 4 + 1] = photo.data[si * 4 + 1];
        cd.data[di * 4 + 2] = photo.data[si * 4 + 2];
        cd.data[di * 4 + 3] = mask[si] < 30 ? 0 : mask[si];
      }
    }
    cctx.putImageData(cd, 0, 0);
    // fit inside the 512 canvas, centred
    const scale = Math.min(1, FIT / Math.max(cw, ch));
    const dw = Math.max(1, Math.round(cw * scale));
    const dh = Math.max(1, Math.round(ch * scale));
    const out = document.createElement("canvas");
    out.width = CANVAS_OUT;
    out.height = CANVAS_OUT;
    const octx = out.getContext("2d")!;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(crop, 0, 0, cw, ch, (CANVAS_OUT - dw) / 2, (CANVAS_OUT - dh) / 2, dw, dh);
    return out.toDataURL("image/png");
  }

  /** Re-export the cutout (throttled — runs after each stroke settles). */
  function emitSave() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const png = buildCutout();
      if (png) onSave(png);
    }, 300);
  }

  /** Soft circular stamp on the mask — brush raises, eraser lowers. */
  function paintAt(x: number, y: number, add: boolean) {
    const mask = maskRef.current;
    const c = canvasRef.current;
    if (!mask || !c) return;
    const w = c.width;
    const h = c.height;
    const r = size / 2;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(w - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(h - 1, Math.ceil(y + r));
    const soft = Math.max(1.5, r * 0.35);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - x, yy - y);
        if (d > r) continue;
        const feather = Math.max(0, Math.min(1, (r - d) / soft));
        const v = Math.round(255 * feather);
        const idx = yy * w + xx;
        if (add) mask[idx] = Math.max(mask[idx], v);
        else mask[idx] = Math.min(mask[idx], 255 - v);
      }
    }
    draw();
    emitSave();
  }

  function strokeTo(x: number, y: number) {
    const last = lastPoint.current ?? { x, y };
    const dist = Math.hypot(x - last.x, y - last.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(2, size / 3)));
    for (let i = 1; i <= steps; i++) {
      paintAt(last.x + ((x - last.x) * i) / steps, last.y + ((y - last.y) * i) / steps, tool === "brush");
    }
    lastPoint.current = { x, y };
  }

  function canvasPoint(e: React.PointerEvent): { x: number; y: number } {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    };
  }

  function onDown(e: React.PointerEvent) {
    if (!editing || !tool || !ready) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawing.current = true;
    pushUndo();
    const p = canvasPoint(e);
    lastPoint.current = p;
    paintAt(p.x, p.y, tool === "brush");
  }
  function onMove(e: React.PointerEvent) {
    if (!drawing.current) return;
    strokeTo(canvasPoint(e).x, canvasPoint(e).y);
  }
  function onUp() {
    drawing.current = false;
    lastPoint.current = null;
  }

  function pushUndo() {
    const mask = maskRef.current;
    if (!mask) return;
    undoRef.current.push(mask.slice());
    if (undoRef.current.length > 30) undoRef.current.shift();
    redoRef.current = [];
    bump((n) => n + 1);
  }
  function undo() {
    const prev = undoRef.current.pop();
    const mask = maskRef.current;
    if (!prev || !mask) return;
    redoRef.current.push(mask.slice());
    mask.set(prev);
    draw();
    emitSave();
    bump((n) => n + 1);
  }
  function redo() {
    const next = redoRef.current.pop();
    const mask = maskRef.current;
    if (!next || !mask) return;
    undoRef.current.push(mask.slice());
    mask.set(next);
    draw();
    emitSave();
    bump((n) => n + 1);
  }

  const toolChip = (t: "brush" | "erase", label: string) => (
    <button
      className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${
        tool === t ? "bg-ink text-paper" : "bg-paper/90 text-ink shadow-hair hover:bg-paper"
      }`}
      onClick={() => setTool(tool === t ? null : t)}
      aria-pressed={tool === t}
    >
      {label}
    </button>
  );

  return (
    <div className="relative h-full w-full">
      {/* letterboxed natural-size canvas inside the 3:4 frame */}
      <div className="flex h-full w-full items-center justify-center">
        <canvas
          ref={canvasRef}
          className={`max-h-full max-w-full touch-none select-none ${
            editing && tool ? "cursor-crosshair" : ""
          }`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        />
      </div>

      {!editing ? (
        /* — idle: green mask preview, Edit pill sits bottom-right — */
        <button
          className={`absolute bottom-2 right-2 rounded-full px-3.5 py-1.5 text-[12px] backdrop-blur-sm transition-colors ${
            ready ? "bg-ink/80 text-paper hover:bg-ink" : "bg-paper/70 text-ink-faint"
          }`}
          onClick={() => ready && setEditing(true)}
        >
          ✎ {dict.addItem.manualEdit}
        </button>
      ) : (
        <>
          {/* — toolbar top-right: eraser + brush, size slider pops left — */}
          <div className="absolute right-2 top-2 flex items-center gap-1.5">
            {tool && (
              <div className="flex items-center gap-2 rounded-full bg-paper/90 px-3 py-1.5 shadow-hair backdrop-blur-sm">
                <input
                  type="range"
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                  className="w-24 accent-ink"
                  aria-label={dict.addItem.brushSize}
                />
                <span className="w-8 text-right text-[11px] text-ink-faint">{size}px</span>
              </div>
            )}
            {toolChip("erase", "◯ " + dict.addItem.toolEraser)}
            {toolChip("brush", "🖌 " + dict.addItem.toolBrush)}
          </div>

          {/* — bottom-right: undo + redo + save — */}
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
            <button
              className="rounded-full bg-paper/90 px-3 py-1.5 text-[12px] text-ink shadow-hair transition-colors hover:bg-paper disabled:opacity-40"
              onClick={undo}
              disabled={undoRef.current.length === 0}
              aria-label={dict.addItem.undo}
            >
              ↺ {dict.addItem.undo}
            </button>
            <button
              className="rounded-full bg-paper/90 px-3 py-1.5 text-[12px] text-ink shadow-hair transition-colors hover:bg-paper disabled:opacity-40"
              onClick={redo}
              disabled={redoRef.current.length === 0}
              aria-label={dict.addItem.redo}
            >
              ↻ {dict.addItem.redo}
            </button>
            <button
              className="rounded-full bg-ink px-3.5 py-1.5 text-[12px] text-paper transition-colors hover:bg-ink/85"
              onClick={() => {
                if (saveTimer.current) window.clearTimeout(saveTimer.current);
                emitSave();
                setEditing(false);
              }}
            >
              {dict.common.save}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
