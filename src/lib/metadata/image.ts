import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the item's cutout to an inline data URL for the AI provider.
 *
 * Privacy (ADR D-04): we only ever send the already-local, minimal
 * representation — the cutout PNG stored on the item (512px transparent), never
 * the raw uploaded photo. Bounded in size so provider payloads stay small.
 */

const MAX_IMAGE_BYTES = 1_500_000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export function resolveItemImage(image: string | null | undefined): string | null {
  if (!image) return null;
  if (image.startsWith("data:")) return image;
  if (!image.startsWith("/uploads/")) return null;

  const absolute = path.join(process.cwd(), "public", image.replace(/^\//, ""));
  try {
    const buf = fs.readFileSync(absolute);
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    const mime = MIME_BY_EXT[path.extname(absolute).toLowerCase()] ?? "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}