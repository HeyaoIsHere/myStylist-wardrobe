import fs from "node:fs";
import path from "node:path";
import type { Store, WardrobeItem } from "@/lib/types";
import { buildSeed } from "./seed";

/**
 * Repository for the demo store: a JSON file under /data, seeded on first
 * access. IMPORTANT: reads and writes go STRAIGHT to disk with no in-memory
 * cache — Next.js compiles API routes and page renderers as separate module
 * instances, so an in-memory cache would let the wardrobe page render stale
 * data after an API mutation. The file is the single source of truth.
 */
const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

/** Migrate older stores forward WITHOUT dropping user-uploaded pieces. */
function migrate(parsed: Partial<Store>): Store {
  const seed = buildSeed();
  seed.wardrobe = (parsed.wardrobe ?? []).map((i) => ({
    id: i.id,
    stem: i.stem,
    image: i.image ?? null,
    // hats & socks were merged into "others" at seedVersion 6
    category:
      (i.category as string) === "hats" || (i.category as string) === "socks" ? "others" : i.category,
    name: i.name,
    addedAt: i.addedAt ?? new Date().toISOString(),
    liked: i.liked ?? false,
  })) as WardrobeItem[];
  seed.outfits = (parsed.outfits ?? []).map((o) => ({
    ...o,
    saved: o.saved ?? false,
    liked: o.liked ?? null,
    disliked: o.disliked ?? false,
  }));
  seed.likedItemIds = parsed.likedItemIds ?? [];
  seed.dislikedItemIds = parsed.dislikedItemIds ?? [];
  return seed;
}

function readFromDisk(): Store {
  if (!fs.existsSync(STORE_PATH)) {
    const seed = buildSeed();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Partial<Store>;
  if (parsed.seedVersion !== buildSeed().seedVersion) {
    const migrated = migrate(parsed);
    fs.writeFileSync(STORE_PATH, JSON.stringify(migrated, null, 2));
    return migrated;
  }
  return parsed as Store;
}

/** Always the freshest state — re-reads the file on every call. */
export function getStore(): Store {
  return readFromDisk();
}

export function saveStore(store: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function mutateStore(fn: (store: Store) => Store): Store {
  const next = fn(readFromDisk());
  saveStore(next);
  return next;
}

export function resetStore(): Store {
  const seed = buildSeed();
  saveStore(seed);
  return seed;
}
