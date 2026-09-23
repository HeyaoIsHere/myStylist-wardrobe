import fs from "node:fs";
import path from "node:path";
import type { IndexMeta, ScoredHit, VectorRecord, VectorStore } from "./types";

/**
 * Flat-file vector store behind the `VectorStore` seam (ADR D-18).
 *
 * · A single JSON file (default `data/embeddings.json`) holding `{seedVersion,
 *   records: { [itemId]: VectorRecord } }`. At ~10²–10⁴ items the whole index
 *   fits comfortably in memory; cosine is in-process.
 * · Same discipline as `metadata/store.ts`: straight-to-disk reads, no cache,
 *   seed + migrate on version bump, ATOMIC writes (tmp + rename) to shrink the
 *   lost-update window (ADR D-12).
 * · `upsert` is keyed by `itemId` — duplicates are impossible by construction.
 *
 * Graduation: swap this class for a pgvector/Qdrant/embedded-HNSW store behind
 * the same interface when the scalability triggers fire — nothing else changes.
 */

const FILE_VERSION = 1;

interface FileShape {
  seedVersion: number;
  records: Record<string, VectorRecord>;
}

function defaultPath(): string {
  return process.env.MYSTYLIST_EMBEDDINGS_FILE
    ? path.resolve(process.env.MYSTYLIST_EMBEDDINGS_FILE)
    : path.join(process.cwd(), "data", "embeddings.json");
}

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  return v.map((x) => x * inv);
}

export class FlatFileVectorStore implements VectorStore {
  readonly name = "flat-file";
  private readonly file: string;
  private records: Map<string, VectorRecord> = new Map();
  private loaded = false;

  constructor(filePath?: string) {
    this.file = filePath ?? defaultPath();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.file)) {
      this.save();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // Corrupt file → reseed rather than throw into a request path.
      this.save();
      return;
    }
    const shape = parsed as Partial<FileShape> | null;
    const raw = shape?.records && typeof shape === "object" ? shape.records : {};
    for (const [id, rec] of Object.entries(raw)) {
      if (rec && typeof rec === "object" && Array.isArray((rec as { vector?: unknown }).vector)) {
        this.records.set(id, rec as VectorRecord);
      }
    }
  }

  /** Separates the "write" concern so tests can force-store failures. */
  save(): void {
    const file = this.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const shape: FileShape = { seedVersion: FILE_VERSION, records: Object.fromEntries(this.records) };
    fs.writeFileSync(tmp, JSON.stringify(shape));
    fs.renameSync(tmp, file);
  }

  get(itemId: string): VectorRecord | null {
    this.load();
    return this.records.get(itemId) ?? null;
  }

  upsert(record: VectorRecord): void {
    this.load();
    const prev = this.records.get(record.itemId);
    this.records.set(record.itemId, record);
    try {
      this.save();
    } catch (err) {
      // failed write ⇒ roll the in-memory index back so callers never see a
      // phantom record that is not on disk (ADR D-12 single-source discipline).
      if (prev === undefined) this.records.delete(record.itemId);
      else this.records.set(record.itemId, prev);
      throw err;
    }
  }

  remove(itemId: string): void {
    this.load();
    const prev = this.records.get(itemId);
    if (this.records.delete(itemId)) {
      try {
        this.save();
      } catch (err) {
        if (prev !== undefined) this.records.set(itemId, prev);
        throw err;
      }
    }
  }

  prune(keepItemIds: ReadonlySet<string>): string[] {
    this.load();
    const removed: string[] = [];
    // capture removed records BEFORE deletion so a failed save can roll back
    const reverted: Array<[string, VectorRecord]> = [];
    for (const [id, rec] of [...this.records.entries()]) {
      if (!keepItemIds.has(id)) {
        reverted.push([id, rec]);
        this.records.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) {
      try {
        this.save();
      } catch (err) {
        for (const [id, rec] of reverted) this.records.set(id, rec);
        throw err;
      }
    }
    return removed;
  }

  all(): VectorRecord[] {
    this.load();
    return [...this.records.values()];
  }

  count(): number {
    this.load();
    return this.records.size;
  }

  meta(): IndexMeta | null {
    this.load();
    if (this.records.size === 0) return null;
    // meta reflects the index as a whole; take the most recently updated record.
    let latest: VectorRecord | null = null;
    for (const rec of this.records.values()) {
      if (!latest || rec.updatedAt > latest.updatedAt) latest = rec;
    }
    const r = latest!;
    return {
      model: r.model,
      embeddingVersion: r.embeddingVersion,
      textVersion: r.textVersion,
      dimension: r.dimension,
      count: this.records.size,
      updatedAt: r.updatedAt,
    };
  }

  search(vector: number[], opts: { topK?: number } = {}): ScoredHit[] {
    this.load();
    const query = l2Normalize([...vector]);
    const topK = opts.topK ?? 20;
    const hits: ScoredHit[] = [];
    for (const rec of this.records.values()) {
      if (rec.dimension !== query.length) continue; // incompatible dims — skip
      const score = dot(query, rec.vector);
      if (!Number.isFinite(score)) continue;
      hits.push({ itemId: rec.itemId, score, record: rec });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}