import fs from "node:fs";
import path from "node:path";
import type { ClothingMetadataRecord, MetadataFileShape } from "./schema";

/**
 * Repository for AI clothing metadata: a JSON file under /data, kept SEPARATE
 * from store.json so that no AI processing can ever corrupt wardrobe data
 * (ADR D-15). Same discipline as src/lib/db/store.ts: straight-to-disk reads,
 * no in-memory cache, seed + migrate on version bump.
 *
 * Env override (used by tests): MYSTYLIST_METADATA_FILE
 */

const SEED_VERSION = 1;

function metadataPath(): string {
  const fromEnv = process.env.MYSTYLIST_METADATA_FILE;
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), "data", "metadata.json");
}

function seedShape(): MetadataFileShape {
  return { seedVersion: SEED_VERSION, entries: {} };
}

/** Keep older store files data-valuable: entries are self-contained records. */
function migrate(parsed: unknown): MetadataFileShape {
  const out = seedShape();
  const raw = parsed as { entries?: Record<string, unknown> } | null;
  if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
    out.entries = raw.entries as Record<string, ClothingMetadataRecord>;
  }
  out.seedVersion = SEED_VERSION;
  return out;
}

function readEntries(): Record<string, ClothingMetadataRecord> {
  const file = metadataPath();
  if (!fs.existsSync(file)) {
    const seed = seedShape();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seed, null, 2));
    return seed.entries;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Corrupt file → reseed rather than throw into the request path.
    const seed = seedShape();
    fs.writeFileSync(file, JSON.stringify(seed, null, 2));
    return seed.entries;
  }
  const shape = parsed as Partial<MetadataFileShape>;
  if (shape.seedVersion !== SEED_VERSION) return migrate(parsed).entries;
  return (shape.entries ?? {});
}

/** Atomic-ish write (tmp + rename) to reduce the lost-update window (ADR D-12). */
function writeEntries(entries: Record<string, ClothingMetadataRecord>): void {
  const file = metadataPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ seedVersion: SEED_VERSION, entries }, null, 2));
  fs.renameSync(tmp, file);
}

export function getMetadata(itemId: string): ClothingMetadataRecord | null {
  return readEntries()[itemId] ?? null;
}

/** All persisted records (used by reindex-all). Order is unspecified. */
export function listMetadata(): ClothingMetadataRecord[] {
  return Object.values(readEntries());
}

export function saveMetadataRecord(record: ClothingMetadataRecord): void {
  const entries = readEntries();
  entries[record.itemId] = record;
  writeEntries(entries);
}

export function deleteMetadata(itemId: string): void {
  const entries = readEntries();
  if (!(itemId in entries)) return;
  delete entries[itemId];
  writeEntries(entries);
}