import { matchesConstraints } from "../retrieval/constraints";
import type { MetadataConstraints } from "../retrieval/types";
import type { ClothingAttributes } from "../metadata/schema";
import { type Season, type Weather } from "../metadata/vocab";
import type { Category } from "../types";
import type {
  DeterministicValidation,
  SemanticValidation,
  OutfitValidation,
  OutfitItemView,
  ValidationCheck,
} from "./types";

/**
 * The DETERMINISTIC outfit-validation lane (Phase 4, ADR D-23).
 *
 * Purely factual guards over an already-composed look — no judgement, no LLM,
 * no data mutation. Hard failures here are absolute: they override any LLM
 * approval in the semantic lane ({@link combineValidation}).
 *
 * Guard semantics:
 *   · item-exists / item-in-wardrobe / no-stale — every recommended id must
 *     resolve to a live catalog entry THAT IS in the active wardrobe; a stale
 *     vector lingering in the index is rejected. (Compose already drops ghosts;
 *     this re-verifies with fresh evidence — belt and braces.)
 *   · no-duplicates — a look never contains the same piece twice.
 *   · hard-constraint-satisfied — re-runs the SAME `matchesConstraints` the
 *     retrieval lane used (no logic duplicated) with empty arrays stripped, so
 *     a hand-built empty filter can never silently match nothing.
 *   · required-categories — "when applicable": a request that asked for a
 *     top AND a bottom must deliver both; a request that asked for a dress
 *     must deliver a dress (or a top+bottom that honestly stood in — see the
 *     dressWins rule in compose). Pure accent requests don't oblige a core.
 *   · weather-suitability — "when metadata allows": only enforced when the
 *     request asked for season(s) AND the item actually carries weather data.
 *     An item tagged for weather incompatible with the demanded season fails.
 *
 * Every guard emits a coded `ValidationCheck` (id + label + detail), so the
 * rejection reason stays human-readable and telemetry stays free of free text.
 */

/** Weather an item should tolerate per requested season (deterministic). */
export const SEASON_WEATHER: Record<Season, Weather[]> = {
  spring: ["cool", "mild"],
  summer: ["warm", "hot"],
  autumn: ["cool", "mild"],
  winter: ["cold", "cool"],
};

export interface DeterministicValidateInput {
  /** the composed look — ids ONLY (grounding preserved). */
  requested: OutfitItemView[];
  /** the hard constraints the retrieval lane was asked to honor. */
  constraints: MetadataConstraints;
  /** the active wardrobe id set. */
  wardrobeIds: ReadonlySet<string>;
  getItem: (id: string) => { id: string; category: Category } | null;
  getAttrs: (id: string) => ClothingAttributes | null;
}

/** Strip empty arrays so a hand-made `[]` constraint can never match nothing. */
function sanitizeConstraints(c: MetadataConstraints): MetadataConstraints {
  const out: MetadataConstraints = {};
  if (c.categories?.length) out.categories = c.categories;
  if (c.colors?.length) out.colors = c.colors;
  if (c.materials?.length) out.materials = c.materials;
  if (c.seasons?.length) out.seasons = c.seasons;
  if (c.occasions?.length) out.occasions = c.occasions;
  if (c.formality) out.formality = c.formality;
  if (c.excludeIds?.length) out.excludeIds = c.excludeIds;
  return out;
}

function check(
  c: Omit<ValidationCheck, "passed"> & { passed: boolean },
): ValidationCheck {
  return c;
}

export function validateOutfitDeterministic(input: DeterministicValidateInput): DeterministicValidation {
  const { requested, constraints, wardrobeIds } = input;
  const c = sanitizeConstraints(constraints);
  const checks: ValidationCheck[] = [];

  // 1 — every id exists (resolves to a catalog entry).
  {
    const missing = requested.filter((i) => !input.getItem(i.id));
    checks.push(
      check({
        id: "item-exists",
        label: "every item exists",
        passed: missing.length === 0,
        detail: missing.length ? `missing ids: ${missing.map((m) => m.id).join(", ")}` : `${requested.length} id(s) resolve`,
      }),
    );
  }

  // 2 — every id belongs to the active wardrobe.
  {
    const foreign = requested.filter((i) => !wardrobeIds.has(i.id));
    checks.push(
      check({
        id: "item-in-wardrobe",
        label: "every item is in the active wardrobe",
        passed: foreign.length === 0,
        detail: foreign.length ? `not in wardrobe: ${foreign.map((f) => f.id).join(", ")}` : "all ids are wardrobe members",
      }),
    );
  }

  // 3 — no duplicate pieces.
  {
    const seen = new Set<string>();
    const dupes = requested.filter((i) => (seen.has(i.id) ? true : (seen.add(i.id), false)));
    checks.push(
      check({
        id: "no-duplicates",
        label: "no duplicate pieces",
        passed: dupes.length === 0,
        detail: dupes.length ? `duplicates: ${dupes.map((d) => d.id).join(", ")}` : `${requested.length} unique piece(s)`,
      }),
    );
  }

  // 4 — hard constraints still satisfied (same predicate as retrieval).
  {
    const constrained = c.categories || c.colors || c.materials || c.seasons || c.occasions || c.formality || c.excludeIds;
    const violations = constrained
      ? requested.filter((i) => {
          const item = input.getItem(i.id);
          return !item || !matchesConstraints(item, input.getAttrs(i.id), c);
        })
      : [];
    checks.push(
      check({
        id: "hard-constraint-satisfied",
        label: "hard constraints are satisfied",
        passed: violations.length === 0,
        detail: violations.length
          ? `violating ids: ${violations.map((v) => v.id).join(", ")}`
          : constrained
            ? "every piece satisfies the requested hard constraints"
            : "no hard constraints requested",
      }),
    );
  }

  // 5 — required core categories, when applicable.
  {
    const cats = c.categories ?? [];
    const wantsDress = cats.includes("dresses");
    const wantsPair = cats.includes("tops") && cats.includes("bottoms");
    const present = (role: string) => requested.some((i) => i.category === role);
    const unmet: string[] = [];
    if (wantsDress && !present("dresses")) unmet.push("a dress");
    if (wantsPair) {
      if (!present("tops")) unmet.push("a top");
      if (!present("bottoms")) unmet.push("a bottom");
    }
    checks.push(
      check({
        id: "required-categories",
        label: "required categories are present",
        passed: unmet.length === 0,
        detail: unmet.length
          ? `missing ${unmet.join(" and ")} (requested categories [${cats.join(", ")}])`
          : wantsDress || wantsPair
            ? "requested core present"
            : "no core requirement (accents only)",
      }),
    );
  }

  // 6 — deleted / stale references rejected (fresh evidence, explicit guard).
  {
    const stale = requested.filter((i) => !input.getItem(i.id) || !wardrobeIds.has(i.id));
    checks.push(
      check({
        id: "no-stale-items",
        label: "no deleted or stale items",
        passed: stale.length === 0,
        detail: stale.length ? `stale ids: ${stale.map((s) => s.id).join(", ")}` : "all ids are live",
      }),
    );
  }

  // 7 — deterministic weather constraints, when metadata allows.
  {
    const seasons = c.seasons ?? [];
    const expected = new Set<Weather>();
    for (const s of seasons) for (const w of SEASON_WEATHER[s]) expected.add(w);
    // With no season requested there is NO expected-weather set, so no item can
    // be flagged unsuitable (vacuous). Enforcing weather needs BOTH a demanded
    // season AND an item that carries weather metadata ("when metadata allows").
    let anyWeather = false;
    const unsuitable =
      seasons.length === 0
        ? []
        : requested.filter((i) => {
            const attrs = input.getAttrs(i.id);
            if (!attrs || attrs.weatherSuitability.length === 0) return false; // metadata doesn't allow
            anyWeather = true;
            return !attrs.weatherSuitability.some((w) => expected.has(w));
          });
    const detail = unsuitable.length
      ? `${unsuitable.map((u) => u.id).join(", ")} unsuited for [${seasons.join(", ")}]`
      : seasons.length === 0
        ? "no season requested — not applicable"
        : !anyWeather
          ? "seasons requested but no item carries weather metadata — not applicable"
          : "every piece with weather metadata is compatible";
    checks.push(
      check({
        id: "weather-suitability",
        label: "pieces suit the requested weather",
        passed: unsuitable.length === 0,
        detail,
      }),
    );
  }

  return { passed: checks.every((x) => x.passed), checks };
}

/** Final verdict: deterministic is absolute; semantic may only *add* failures. */
export function combineValidation(det: DeterministicValidation, sem: SemanticValidation): OutfitValidation {
  const passed = det.passed && (sem.passed === null ? true : sem.passed);
  return { passed, deterministic: det, semantic: sem };
}