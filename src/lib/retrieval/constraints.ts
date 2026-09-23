import type { ClothingAttributes } from "../metadata/schema";
import type { Category } from "../types";
import type { MetadataConstraints } from "./types";

/**
 * The deterministic hard-constraint lane (Hybrid Retrieval Future Design).
 * A pure predicate over (item, attrs) — exact, explainable, unit-testable.
 *
 * Semantics: constraints are ANDed; each attribute constraint REQUIRES a match,
 * and items without attributes (degraded extraction) cannot satisfy any
 * attribute constraint. `excludeIds` is an absolute veto.
 */
export function matchesConstraints(
  item: { id: string; category: Category },
  attrs: ClothingAttributes | null,
  c: MetadataConstraints,
): boolean {
  if (c.excludeIds?.includes(item.id)) return false;
  if (c.categories && !c.categories.includes(item.category)) return false;

  const a = attrs;
  if (c.colors?.length && (!a || !a.colors.some((col) => c.colors!.includes(col.name)))) return false;
  if (c.materials?.length && (!a || !a.material.some((m) => c.materials!.includes(m)))) return false;
  if (c.seasons?.length && (!a || !a.seasons.some((s) => c.seasons!.includes(s)))) return false;
  if (c.occasions?.length && (!a || !a.occasions.some((o) => c.occasions!.includes(o)))) return false;
  if (c.formality !== undefined && c.formality !== null) {
    if (!a || a.formality !== c.formality) return false;
  }
  return true;
}

/** Returns [itemIds] that pass the constraints when joined with the candidate set. */
export function filterByConstraints(
  itemIds: string[],
  constraints: MetadataConstraints | null | undefined,
  ctx: {
    getItem: (id: string) => { id: string; category: Category } | null;
    getAttrs: (id: string) => ClothingAttributes | null;
  },
): { passed: string[]; filters: Record<string, unknown> } {
  const filters = constraints ? normalizeFilters(constraints) : {};
  if (!constraints) return { passed: itemIds, filters };
  const passed = itemIds.filter((id) => {
    const item = ctx.getItem(id);
    if (!item) return false;
    return matchesConstraints(item, ctx.getAttrs(id), constraints);
  });
  return { passed, filters };
}

function normalizeFilters(c: MetadataConstraints): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.categories) out.categories = c.categories;
  if (c.colors) out.colors = c.colors;
  if (c.materials) out.materials = c.materials;
  if (c.seasons) out.seasons = c.seasons;
  if (c.occasions) out.occasions = c.occasions;
  if (c.formality) out.formality = c.formality;
  if (c.excludeIds) out.excludeIds = c.excludeIds;
  return out;
}