import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FORMALITY, SEASONS, WEATHER } from "../../src/lib/metadata/vocab";
import type { EvalCatalogItem, EvalCase, EvalGolden } from "./types";
import type { Category } from "../../src/lib/types";
import type { ClothingAttributes } from "../../src/lib/metadata/schema";

/**
 * Loaders + zod validation for the versioned eval datasets. Any drift from the
 * app's own vocab (seasons / formality / weather / category) fails here with a
 * readable error, so a golden can never silently test against a typo'd value.
 */

const CATEGORIES = ["tops", "bottoms", "dresses", "outerwear", "shoes", "bags", "accessories", "others"] as const;

const langSchema = z.enum(["en", "zh"]);
const tagSchema = z.enum(["normal", "hard", "zero", "semantic", "weather", "stale"]);

// ── Catalog ──────────────────────────────────────────────────────────────────

const colorSchema = z.object({ name: z.string(), hex: z.string().optional() });
const attrsSchema = z.object({
  subcategory: z.string().optional(),
  colors: z.array(colorSchema),
  material: z.array(z.string()),
  pattern: z.array(z.string()),
  fit: z.string().nullable().optional(),
  styleTags: z.array(z.string()),
  seasons: z.array(z.enum(SEASONS)),
  occasions: z.array(z.string()),
  formality: z.enum(FORMALITY).nullable().optional(),
  weatherSuitability: z.array(z.enum(WEATHER)),
});
const catalogItemSchema = z.object({
  item: z.object({
    id: z.string(),
    name: z.string(),
    category: z.enum(CATEGORIES),
  }),
  attrs: attrsSchema.nullable(),
});
const catalogFileSchema = z.object({
  schemaName: z.literal("mystylist-eval-catalog"),
  schemaVersion: z.literal("1"),
  description: z.string().optional(),
  catalog: z.array(catalogItemSchema),
});

// ── Golden set ───────────────────────────────────────────────────────────────

const metadataConstraintsSchema = z.object({
  categories: z.array(z.enum(CATEGORIES)).optional(),
  colors: z.array(z.string()).optional(),
  materials: z.array(z.string()).optional(),
  seasons: z.array(z.enum(SEASONS)).optional(),
  occasions: z.array(z.string()).optional(),
  formality: z.enum(FORMALITY).nullable().optional(),
  excludeIds: z.array(z.string()).optional(),
});

const caseSchema = z.object({
  id: z.string(),
  lang: langSchema,
  tags: z.array(tagSchema).min(1),
  query: z.string().min(1),
  seedGhosts: z.array(z.string()).optional(),
  note: z.string().optional(),
  expected: z.object({
    hard: metadataConstraintsSchema,
    ok: z.boolean(),
    relevantIds: z.array(z.string()),
    mustNotContain: z.array(z.string()).optional(),
  }),
});
const goldenFileSchema = z.object({
  schemaName: z.literal("mystylist-eval-golden"),
  schemaVersion: z.literal("1"),
  description: z.string().optional(),
  cases: z.array(caseSchema),
});

const DATA_DIR = join(process.cwd(), "scripts", "eval", "data");

/** Exported for the eval test suite's drift-guard coverage. */
export const catalogSchema = catalogFileSchema;
/** Exported for the eval test suite's drift-guard coverage. */
export const goldenSchema = goldenFileSchema;

/** Load + validate the versioned golden set (data/golden-<version>.json). Throws on drift. */
export function loadGolden(version = "v1"): EvalGolden {
  const raw = readFileSync(join(DATA_DIR, `golden-${version}.json`), "utf8");
  const parsed = goldenFileSchema.parse(JSON.parse(raw));
  // zod feedback keeps our IDs aligned with the domain type.
  return parsed as unknown as EvalGolden;
}

/** Load + validate the synthetic catalog. */
export function loadCatalog(): EvalCatalogItem[] {
  const raw = readFileSync(join(DATA_DIR, "catalog.json"), "utf8");
  const parsed = catalogFileSchema.parse(JSON.parse(raw));
  return parsed.catalog.map((c) => ({
    item: { id: c.item.id, name: c.item.name, category: c.item.category as Category },
    attrs: (c.attrs ?? null) as ClothingAttributes | null,
  }));
}

/** A golden with only its must-contain expectations untouched — consumed by the runner. */
export function validateGolden(g: EvalGolden, catalog: EvalCatalogItem[]): void {
  const catalogIds = new Set(catalog.map((c) => c.item.id));
  const ids = new Set<string>();
  for (const c of g.cases) {
    if (ids.has(c.id)) throw new Error(`duplicate golden case id: ${c.id}`);
    ids.add(c.id);
    for (const ghost of c.seedGhosts ?? []) {
      if (/^ghost-/.test(ghost)) {
        throw new Error(`case ${c.id}: seedGhosts must name a plain catalog id (the runner prefixes ghost-), got '${ghost}'`);
      }
      if (!catalogIds.has(ghost)) {
        throw new Error(`case ${c.id}: seedGhosts id '${ghost}' does not exist in the catalog`);
      }
    }
  }
}

export type { EvalCase };