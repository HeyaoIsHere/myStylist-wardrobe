/**
 * Downloads real fashion photography (Unsplash CDN, no key required) and
 * self-hosted fonts (Cormorant Garamond + Inter) into /public. Items whose
 * photos fail to download fall back to the generated SVG illustrations.
 * Writes src/lib/assets-manifest.json mapping every stem to its final path.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WARDROBE_SLOTS, INSPO_SLOTS, FONTS } from "./asset-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 15000;

async function download(url, dest, minBytes = 8000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/") && !ct.includes("font")) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < minBytes) return false;
    writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

async function fetchPhotos() {
  const results = {};
  for (const slot of WARDROBE_SLOTS) {
    const dest = join(ROOT, "public", "images", "wardrobe", `${slot.stem}.jpg`);
    let ok = false;
    for (const id of slot.candidates) {
      ok = await download(`https://images.unsplash.com/photo-${id}?w=1000&q=80&auto=format&fit=crop`, dest);
      if (ok) break;
    }
    results[slot.stem] = ok ? `/images/wardrobe/${slot.stem}.jpg` : `/images/wardrobe/${slot.stem}.svg`;
    process.stdout.write(ok ? "P" : "s");
  }
  console.log("");
  for (const slot of INSPO_SLOTS) {
    const dest = join(ROOT, "public", "images", "inspo", `${slot.stem}.jpg`);
    let ok = false;
    for (const id of slot.candidates) {
      ok = await download(`https://images.unsplash.com/photo-${id}?w=1200&q=80&auto=format&fit=crop`, dest);
      if (ok) break;
    }
    results[slot.stem] = ok ? `/images/inspo/${slot.stem}.jpg` : `/images/inspo/${slot.stem}.svg`;
    process.stdout.write(ok ? "P" : "s");
  }
  console.log("");
  return results;
}

async function fetchFonts() {
  const cssUrl =
    "https://fonts.googleapis.com/css2?" +
    FONTS.map((f) => `family=${encodeURIComponent(f.family)}:${f.weights.map((w) => (w.italic ? "ital" : "wght") + "@" + w.w).join(";")}`).join("&") +
    "&display=swap";
  const fontsDir = join(ROOT, "public", "fonts");
  mkdirSync(fontsDir, { recursive: true });
  let css = "";
  try {
    const res = await fetch(cssUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
    if (!res.ok) throw new Error("google fonts css failed");
    const text = await res.text();
    const blocks = text.split("@font-face").slice(1);
    const downloaded = [];
    for (const block of blocks) {
      const family = block.match(/font-family:\s*'([^']+)'/)?.[1] || "";
      const style = block.match(/font-style:\s*(\w+)/)?.[1] || "normal";
      const weight = block.match(/font-weight:\s*(\d+)/)?.[1] || "400";
      const url = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)?.[1];
      const range = block.match(/unicode-range:\s*([^;]+)/)?.[1] || "";
      if (!url) continue;
      const isLatin = /U\+0000-00FF/.test(range);
      if (!isLatin && downloaded.some((d) => d.family === family && d.style === style && d.weight === weight)) continue;
      const file = `${family.toLowerCase().replace(/ /g, "-")}-${weight}${style === "italic" ? "-italic" : ""}.woff2`;
      if (await download(url, join(fontsDir, file), 2000)) {
        downloaded.push({ family, style, weight, file });
        css += `@font-face { font-family: "${family}"; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url("/fonts/${file}") format("woff2"); }\n`;
      }
    }
    console.log(`Downloaded ${downloaded.length} font files.`);
  } catch {
    console.log("Font download failed — using system font fallbacks.");
  }
  // Always emit fonts.css so globals.css can @import it safely
  writeFileSync(join(fontsDir, "fonts.css"), css || "/* system font fallbacks in use */\n");
}

const manifest = { wardrobe: {}, inspo: {} };
for (const s of WARDROBE_SLOTS) manifest.wardrobe[s.stem] = `/images/wardrobe/${s.stem}.svg`;
for (const s of INSPO_SLOTS) manifest.inspo[s.stem] = `/images/inspo/${s.stem}.svg`;

const photos = await fetchPhotos();
for (const [stem, path] of Object.entries(photos)) {
  if (stem.startsWith("inspo-")) manifest.inspo[stem] = path;
  else manifest.wardrobe[stem] = path;
}
await fetchFonts();

const libDir = join(ROOT, "src", "lib");
mkdirSync(libDir, { recursive: true });
writeFileSync(join(libDir, "assets-manifest.json"), JSON.stringify(manifest, null, 2));
const photosCount = Object.values(photos).filter((p) => p.endsWith(".jpg")).length;
console.log(`Assets done: ${photosCount}/${WARDROBE_SLOTS.length + INSPO_SLOTS.length} real photos, rest SVG illustrations.`);
