"use client";

/**
 * Client-side background removal: samples the background colour from the
 * image borders, then feathers every pixel's alpha by its distance from
 * that colour. Works well on the plain backgrounds flat-lay photos usually
 * have; returns a transparent-canvas cutout. Real segmentation (rembg /
 * vision API) plugs into the same call sites later.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

function drawScaled(img: HTMLImageElement, maxDim: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Median per-channel colour of the border pixels (background estimate).
 *  Skips already-transparent pixels so pre-cutout PNGs are not damaged. */
function estimateBackground(data: Uint8ClampedArray, w: number, h: number): { r: number; g: number; b: number; uniform: boolean } {
  const samples: number[][] = [[], [], []];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 120));
  for (let x = 0; x < w; x += step) {
    for (const y of [0, h - 1]) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 10) continue;
      samples[0].push(data[i]);
      samples[1].push(data[i + 1]);
      samples[2].push(data[i + 2]);
    }
  }
  for (let y = 0; y < h; y += step) {
    for (const x of [0, w - 1]) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 10) continue;
      samples[0].push(data[i]);
      samples[1].push(data[i + 1]);
      samples[2].push(data[i + 2]);
    }
  }
  // all-transparent border (a sticker) — nothing to cut
  if (samples[0].length === 0) {
    return { r: 0, g: 0, b: 0, uniform: false };
  }
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const r = median(samples[0]);
  const g = median(samples[1]);
  const b = median(samples[2]);
  // A uniform background has low spread; busy scenes abort the cutout.
  const spread = (arr: number[], m: number) =>
    arr.reduce((acc, v) => acc + Math.abs(v - m), 0) / arr.length;
  const uniform = spread(samples[0], r) + spread(samples[1], g) + spread(samples[2], b) < 48;
  return { r, g, b, uniform };
}

const smoothstep = (v: number) => Math.max(0, Math.min(1, v));

/** Cuts the subject out of the photo; falls back to the full image if the
 *  background is too busy to estimate reliably. */
export async function cutoutCanvas(src: string, maxDim = 600): Promise<HTMLCanvasElement> {
  const img = await loadImage(src);
  const canvas = drawScaled(img, maxDim);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const bg = estimateBackground(data, w, h);
  if (!bg.uniform) return canvas; // too busy — keep the original

  const T0 = 16; // fully transparent below this distance
  const T1 = 58; // fully opaque above

  for (let i = 0; i < data.length; i += 4) {
    // already transparent (pre-cutout PNG) — leave untouched
    if (data[i + 3] < 10) {
      data[i + 3] = 0;
      continue;
    }
    const dr = data[i] - bg.r;
    const dg = data[i + 1] - bg.g;
    const db = data[i + 2] - bg.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
    const cut = smoothstep((dist - T0) / (T1 - T0));
    // keep any original transparency (PNG uploads)
    data[i + 3] = Math.round(Math.min(data[i + 3], 255 * cut));
  }

  // sanity check: don't return an empty or untouched image
  let kept = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 200) kept++;
  const ratio = kept / (data.length / 4);
  if (ratio < 0.06 || ratio > 0.985) return canvas;

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Cutout composited onto a pure white background, exported as JPEG. */
export function cutoutToWhite(cutout: HTMLCanvasElement): string {
  const out = document.createElement("canvas");
  out.width = cutout.width;
  out.height = cutout.height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(cutout, 0, 0);
  return out.toDataURL("image/jpeg", 0.88);
}
