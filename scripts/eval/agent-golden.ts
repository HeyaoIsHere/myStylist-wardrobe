import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SEASONS } from "../../src/lib/metadata/vocab";
import { FORMALITY } from "../../src/lib/metadata/vocab";
import { CATEGORY_VALUES } from "../../src/lib/recommend/schemas";
import { AGENT_TOOL_NAMES } from "../../src/lib/agent/types";
import type { AgentEvalCatalogItem, AgentEvalCase, AgentEvalGolden } from "./agent-types";
import type { ClothingAttributes } from "../../src/lib/metadata/schema";
import type { Category } from "../../src/lib/types";

/**
 * Loader + zod validation for the PHASE 6 agent golden set. Same discipline as
 * the Phase 5 golden loader: every trajectory / constraint / termination string
 * is validated against the app's own closed vocabularies, so a typo'd golden can
 * never silently test the wrong target.
 */

const CATEGORIES = CATEGORY_VALUES.filter(
  (c): c is Category => c !== undefined && c !== null,
);

const langSchema = z.enum(["en", "zh"]);
const tagSchema = z.string();
const toolSchema = z.enum(AGENT_TOOL_NAMES);
const terminationSchema = z.enum(["valid-outfit", "no-valid-outfit", "unsatisfiable", "max-iterations", "timeout", "tool-unavailable", "invalid-tool-call", "any"]);

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
  weatherSuitability: z.array(z.string()),
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

const metadataConstraintsSchema = z.object({
  categories: z.array(z.enum(CATEGORIES)).optional(),
  colors: z.array(z.string()).optional(),
  materials: z.array(z.string()).optional(),
  seasons: z.array(z.enum(SEASONS)).optional(),
  occasions: z.array(z.string()).optional(),
  formality: z.enum(FORMALITY).nullable().optional(),
  excludeIds: z.array(z.string()).optional(),
});

const expectedSchema = z.object({
  hard: metadataConstraintsSchema,
  trajectory: z.array(toolSchema).min(1),
  termination: terminationSchema,
  ok: z.boolean(),
  relevantIds: z.array(z.string()),
  mustNotContain: z.array(z.string()).optional(),
  hardStableAcrossSearches: z.boolean().optional(),
});
const caseSchema = z.object({
  id: z.string(),
  lang: langSchema,
  tags: z.array(tagSchema).min(1),
  query: z.string().min(1),
  seedGhosts: z.array(z.string()).optional(),
  note: z.string().optional(),
  expected: expectedSchema,
});
const goldenFileSchema = z.object({
  schemaName: z.literal("mystylist-agent-eval-golden"),
  schemaVersion: z.literal("1"),
  description: z.string().optional(),
  cases: z.array(caseSchema),
});

const DATA_DIR = join(process.cwd(), "scripts", "eval", "data");

/** Exported for the eval test suite's drift-guard coverage. */
export const agentGoldenSchema = goldenFileSchema;
export const agentCatalogSchema = catalogFileSchema;

/** Load + validate the agent golden set (data/agent-golden-<version>.json). */
export function loadAgentGolden(version = "v1"): AgentEvalGolden {
  const raw = readFileSync(join(DATA_DIR, `agent-golden-${version}.json`), "utf8");
  const parsed = goldenFileSchema.parse(JSON.parse(raw));
  return parsed as unknown as AgentEvalGolden;
}

/** Load + validate the synthetic catalog (shared with the Phase 5 eval). */
export function loadCatalog(): AgentEvalCatalogItem[] {
  const raw = readFileSync(join(DATA_DIR, "catalog.json"), "utf8");
  const parsed = catalogFileSchema.parse(JSON.parse(raw));
  return parsed.catalog.map((c) => ({
    item: { id: c.item.id, name: c.item.name, category: c.item.category as Category },
    attrs: (c.attrs ?? null) as ClothingAttributes | null,
  }));
}

/** Cross-case drift guards: unique ids, valid ghost refs, valid relevant ids. */
export function validateAgentGolden(g: AgentEvalGolden, catalog: AgentEvalCatalogItem[]): void {
  const catalogIds = new Set(catalog.map((c) => c.item.id));
  const ids = new Set<string>();
  for (const c of g.cases) {
    if (ids.has(c.id)) throw new Error(`duplicate agent golden case id: ${c.id}`);
    ids.add(c.id);
    for (const ghost of c.seedGhosts ?? []) {
      if (/^ghost-/.test(ghost)) {
        throw new Error(`case ${c.id}: seedGhosts must name a plain catalog id, got '${ghost}'`);
      }
      if (!catalogIds.has(ghost)) {
        throw new Error(`case ${c.id}: seedGhosts id '${ghost}' does not exist in the catalog`);
      }
    }
    for (const r of c.expected.relevantIds) {
      if (!catalogIds.has(r)) {
        throw new Error(`case ${c.id}: relevantIds id '${r}' does not exist in the catalog`);
      }
    }
  }
}

export type { AgentEvalCase };